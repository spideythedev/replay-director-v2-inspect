/**
 * Replay Director - World Event Capture (Phase 3F, extended for World
 * Interaction Replay)
 *
 * Runs alongside capture.js (player state) during a recording session,
 * without touching it - this is a separate, additive listener layer.
 * Timestamps events using recordingState.tick, which capture.js already
 * maintains every tick.
 *
 * Scope decisions worth knowing:
 * - Commands: no world event exists for "a player ran a command" in the
 *   stable Script API, so this can't be captured at all - not a bug, a
 *   real API gap.
 * - Sounds: no generic "a sound occurred" event exists, so sounds aren't
 *   captured as a distinct primitive.
 * - Weather/Time: deliberately not captured here - see snapshot.js/roadmap
 *   notes; even if reading them were fully solved, changing them live
 *   during someone else's replay viewing later would affect the whole
 *   shared world, which this addon avoids by design.
 *
 * World Replay addition (block_place/block_break/block_interact/
 * block_explode): each event now carries beforePermutation/afterPermutation
 * snapshots (typeId + block states) where available, not just a bare
 * typeId - worldReplay.js needs the full permutation to both apply a
 * change forward AND undo it exactly when seeking backward. afterPermutation
 * is always captured where the API gives us a post-event block reference.
 * beforePermutation is captured wherever the API exposes it directly
 * (block_break via brokenBlockPermutation, block_explode via
 * event.explodedBlockPermutation, block_interact by snapshotting the
 * block just before the interaction is applied); for block_place it is
 * left undefined, since this API build has no beforeEvents.playerPlaceBlock
 * to read the pre-placement state from - worldReplay.js falls back to air
 * in that case, which is correct for the overwhelming majority of
 * placements (you can only place into replaceable blocks, and air is by
 * far the most common).
 *
 * block_interact (new, generic): captures via afterEvents.playerInteractWithBlock,
 * which fires for ANY block a player right-clicks - this is deliberately
 * NOT hardcoded to respawn anchors or any other specific block type. It
 * records the block's permutation before and after the interaction
 * returned to script, whatever it turns out to be. Respawn Anchor charging
 * (its charge count state changes on interact) is naturally covered by
 * this generic capture without any special-casing - so are any other
 * present or future blocks whose state changes on right-click. Only
 * interactions that actually change the block's permutation are worth
 * replaying, so ones where before === after (e.g. right-clicking a solid
 * block that does nothing) are filtered out to avoid needless world writes
 * on playback, not because they were selectively captured.
 *
 * block_explode (new, generic): captures via afterEvents.blockExplode,
 * which fires once per destroyed block for ANY explosion (TNT, creeper,
 * bed/respawn anchor in the wrong dimension, End Crystal, ghast fireball,
 * etc.) - again, not hardcoded to any specific explosion source. This is
 * what makes Respawn Anchor explosion and End Crystal explosion (the
 * examples named in the task) replay correctly: they are just instances of
 * this generic block-destruction-by-explosion primitive, same as any
 * other. The already-existing `explosion` event (particle-only, captured
 * from afterEvents.explosion) is untouched and keeps driving the visual
 * explosion particle; block_explode is purely about the block-state side.
 *
 * Entity replay scope: generic entitySpawn is deliberately NOT captured.
 * Only supported replay-mob deaths are captured through entityDie, because
 * those mobs have intentional puppet implementations in mobSupport.js.
 * entityRemove is not treated as death because Bedrock can remove an entity
 * when it unloads from the active simulation.
 *
 * NOT CAPTURED - confirmed API gap: chest (and other container) open/close.
 * A container's open/closed state is purely a client-side visual (lid
 * animation), not a BlockPermutation state and not exposed by any
 * Script API event - there is no stable "container opened/closed" signal
 * to capture at all, on Bedrock or otherwise. playerInteractWithBlock does
 * fire when a player right-clicks a chest, but the block's permutation
 * before and after is identical, so block_interact's real-diff filter
 * correctly finds nothing to record - that's the filter working as
 * designed, not a bug in it. Faking an open/close toggle with no real
 * signal behind it would violate the "don't fake events" requirement, so
 * this stays unimplemented until a real capture primitive exists.
 */

import { world, EquipmentSlot } from "@minecraft/server";
import { recordingState } from "./recordingState.js";

const state = {
    active: false,
    events: [],
    unsubscribers: []
};

/**
 * playerInteractWithBlock only has an afterEvent that's actually readable
 * here (the beforeEvent version exists solely to let scripts cancel the
 * interaction, per its own docs) - but a beforeEvent still fires strictly
 * before the interaction is applied, so subscribing to it here (without
 * ever setting event.cancel) is the one honest way to read the block's
 * true pre-interaction permutation. This map bridges that snapshot from
 * the beforeEvent to the afterEvent that fires immediately after it, for
 * the same interaction. Keyed by playerId since a single player can only
 * be mid-interaction with one block at a time.
 * @type {Map<string, {typeId:string, states:object}|undefined>}
 */
const pendingInteractBefore = new Map();

/** @returns {boolean} whether two permutation snapshots (from snapshotPermutation) represent the same block state - used to filter out no-op interactions, not to guess at anything the API didn't actually report. */
function permutationsEqual(a, b) {
    if (!a && !b) return true;
    if (!a || !b) return false;
    if (a.typeId !== b.typeId) return false;
    const aKeys = Object.keys(a.states || {});
    const bKeys = Object.keys(b.states || {});
    if (aKeys.length !== bKeys.length) return false;
    for (const key of aKeys) {
        if (a.states[key] !== b.states[key]) return false;
    }
    return true;
}

/** @returns {{typeId:string, states:object}|undefined} */
function snapshotPermutation(permutation) {
    if (!permutation) return undefined;
    try {
        return { typeId: permutation.type.id, states: permutation.getAllStates() };
    } catch (e) {
        try {
            return { typeId: permutation.type.id, states: {} };
        } catch (e2) {
            return undefined;
        }
    }
}

/** The player's mainhand item typeId at this exact moment, via the same confirmed-real minecraft:equippable path used elsewhere - used to classify which tool/weapon swing animation an event should play back with. Returns undefined for an empty hand (bare-hand punch/mine) or if the component/slot isn't readable. */
function getMainhandTypeId(player) {
    if (!player) return undefined;
    try {
        const equippable = player.getComponent("minecraft:equippable");
        const mainhand = equippable ? equippable.getEquipmentSlot(EquipmentSlot.Mainhand) : undefined;
        const item = mainhand ? mainhand.getItem() : undefined;
        return item ? item.typeId : undefined;
    } catch (e) {
        return undefined;
    }
}

/**
 * Records a second block_place event for a multi-block placement's
 * companion half (door top, bed second half, tall two-block plant's
 * other half) when the block that just fired playerPlaceBlock is one of
 * these types. Deliberately identified by typeId substring match only
 * (not by reading specific block state field names) - state key names
 * for these blocks weren't confirmed with the same confidence as
 * everything else in this file, and guessing wrong there risks silently
 * capturing nothing, same failure mode this is fixing. typeId matching
 * has no such risk since every call site in this codebase already
 * trusts typeId directly.
 *
 * By the time afterEvents.playerPlaceBlock fires, the engine has already
 * synchronously placed the companion half, so both the block above and
 * below are checked (doors/beds companion is always above the clicked
 * half in vanilla's placement behavior; checking below too is a cheap,
 * harmless safety net in case that's ever not true for some block).
 * Only actually pushes an event if a companion block is found and isn't
 * air, so this is a no-op for every ordinary single-block placement.
 *
 * @param {import("@minecraft/server").Block} placedBlock
 * @param {import("@minecraft/server").Player|undefined} player
 */
function captureMultiBlockCompanion(placedBlock, player) {
    try {
        const typeId = placedBlock.typeId;
        const isMultiBlockType = typeId.includes("door") || typeId.includes("bed") || typeId.includes("double_plant") || typeId.includes("tall_grass") || typeId.includes("large_fern") || typeId.includes("sunflower") || typeId.includes("lilac") || typeId.includes("rose_bush") || typeId.includes("peony");
        if (!isMultiBlockType) return;

        const dimension = placedBlock.dimension;
        const loc = placedBlock.location;
        const candidates = [
            { x: loc.x, y: loc.y + 1, z: loc.z },
            { x: loc.x, y: loc.y - 1, z: loc.z }
        ];

        for (const candidateLoc of candidates) {
            const companion = dimension.getBlock(candidateLoc);
            if (!companion || companion.typeId === "minecraft:air") continue;
            // Only record it if the neighbor is genuinely the same
            // multi-block family as what was just placed - avoids
            // misfiring when, say, a door is placed right next to an
            // unrelated block that happens to sit above/below it. Doors
            // and tall plants share the exact same typeId across both
            // halves; beds can differ (foot/head are sometimes distinct
            // block ids), so beds are matched by family (both typeIds
            // containing "bed") rather than requiring an exact match.
            const sameDoorOrPlant = companion.typeId === typeId && isMultiBlockType;
            const sameBedFamily = typeId.includes("bed") && companion.typeId.includes("bed");
            if (!sameDoorOrPlant && !sameBedFamily) continue;

            push("block_place", {
                blockTypeId: companion.typeId,
                location: { ...candidateLoc },
                playerId: player ? player.id : undefined,
                toolTypeId: getMainhandTypeId(player),
                beforePermutation: undefined,
                afterPermutation: snapshotPermutation(companion.permutation)
            }, dimension.id, candidateLoc);
        }
    } catch (e) {
        // fail soft - never let companion-block capture break the primary
        // block_place event above, which has already been pushed by now
    }
}

function isWithinRecordingScope(dimensionId, location) {
    const bounds = recordingState.recordingBounds;
    if (!bounds || !dimensionId || !location) return false;
    if (dimensionId !== bounds.dimensionId) return false;
    return (
        location.x >= bounds.from.x && location.x <= bounds.to.x &&
        location.y >= bounds.from.y && location.y <= bounds.to.y &&
        location.z >= bounds.from.z && location.z <= bounds.to.z
    );
}

function scopedEventData(data, dimensionId, location) {
    if (!isWithinRecordingScope(dimensionId, location)) return undefined;
    return {
        ...data,
        dimensionId,
        location: location ? { ...location } : data.location
    };
}

export function startEventCapture() {
    if (state.active) return false;

    state.active = true;
    state.events = [];
    state.unsubscribers = [];

    // Note: there is no beforeEvents.playerPlaceBlock in this API build (it
    // is undefined here), so beforePermutation for block_place can't be
    // captured at record time - worldReplay.js already falls back to air
    // when beforePermutation is missing, so placements still undo correctly
    // on seek/stop, just without this extra precision.
    subscribe(world.afterEvents.playerPlaceBlock, (event) => {
        push("block_place", {
            blockTypeId: event.block.typeId,
            location: { ...event.block.location },
            playerId: event.player ? event.player.id : undefined,
            toolTypeId: getMainhandTypeId(event.player),
            beforePermutation: undefined,
            afterPermutation: snapshotPermutation(event.block.permutation)
        }, event.block.dimension.id, event.block.location);
        // Multi-block placements (doors, beds, tall two-block plants like
        // tall grass/sunflower/lilac/rose bush/peony) only fire this event
        // ONCE, for the half the player actually clicked - the engine
        // places the companion half as a synchronous side effect that
        // never gets its own playerPlaceBlock event. Without this, that
        // companion half is simply never recorded, so on replay (after the
        // pre-playback snapshot restore clears the region - see
        // snapshot.js) only the primary half gets rebuilt and the block
        // renders broken/invisible - this is the actual cause of "doors/
        // items disappearing" in replays. By the time this handler runs,
        // the engine has already placed the companion half, so it's safe
        // to read and record it directly as its own block_place event.
        captureMultiBlockCompanion(event.block, event.player);
    }, (cb) => world.afterEvents.playerPlaceBlock.unsubscribe(cb));

    subscribe(world.afterEvents.playerBreakBlock, (event) => {
        push("block_break", {
            blockTypeId: event.brokenBlockPermutation ? event.brokenBlockPermutation.type.id : undefined,
            location: { ...event.block.location },
            playerId: event.player ? event.player.id : undefined,
            toolTypeId: getMainhandTypeId(event.player),
            beforePermutation: snapshotPermutation(event.brokenBlockPermutation),
            afterPermutation: snapshotPermutation(event.block.permutation)
        }, event.block.dimension.id, event.block.location);
    }, (cb) => world.afterEvents.playerBreakBlock.unsubscribe(cb));

    // Generic block-interaction capture - fires for ANY block right-click,
    // not just respawn anchors. See file header. Two subscriptions work
    // together here: the beforeEvent (never cancelled - only read) captures
    // the block's true pre-interaction permutation, since it fires strictly
    // before the interaction is applied; the afterEvent then fires
    // immediately after with the block already mutated, so reading it there
    // gives the true afterPermutation. Pairing them via pendingInteractBefore
    // (keyed by playerId) is what lets this be a real before/after diff
    // instead of a guess.
    subscribe(world.beforeEvents.playerInteractWithBlock, (event) => {
        try {
            const playerId = event.player ? event.player.id : undefined;
            if (!playerId) return;
            pendingInteractBefore.set(playerId, snapshotPermutation(event.block ? event.block.permutation : undefined));
        } catch (e) {
            // fail soft
        }
    }, (cb) => world.beforeEvents.playerInteractWithBlock.unsubscribe(cb));

    subscribe(world.afterEvents.playerInteractWithBlock, (event) => {
        try {
            const block = event.block;
            if (!block) return;
            const playerId = event.player ? event.player.id : undefined;
            const beforePermutation = playerId ? pendingInteractBefore.get(playerId) : undefined;
            if (playerId) pendingInteractBefore.delete(playerId);

            const afterPermutation = snapshotPermutation(block.permutation);

            // Only worth recording (and replaying) if the interaction
            // actually changed the block's state - e.g. charging a respawn
            // anchor changes its charge-count block state, but right-
            // clicking a block that does nothing (or that only triggers a
            // sound/particle we can't capture anyway) leaves before/after
            // identical. This is a real-data filter, not a guessed one:
            // both snapshots come from the actual block, just at two real
            // points in time.
            if (permutationsEqual(beforePermutation, afterPermutation)) return;

            // itemStack (post-interaction) tells us what's left in hand,
            // useful context but not required for the block-state replay.
            const itemTypeId = event.itemStack ? event.itemStack.typeId : undefined;

            push("block_interact", {
                blockTypeId: block.typeId,
                location: { ...block.location },
                playerId,
                itemTypeId,
                beforePermutation,
                afterPermutation
            }, block.dimension.id, block.location);
        } catch (e) {
            // fail soft
        }
    }, (cb) => world.afterEvents.playerInteractWithBlock.unsubscribe(cb));

    // Generic explosion-caused block destruction - fires once per block for
    // ANY explosion source (TNT, creeper, bed/respawn anchor explosion, End
    // Crystal, ghast fireball, etc.), not hardcoded to any one of them.
    subscribe(world.afterEvents.blockExplode, (event) => {
        try {
            push("block_explode", {
                blockTypeId: event.explodedBlockPermutation ? event.explodedBlockPermutation.type.id : undefined,
                location: { ...event.block.location },
                // No player is necessarily involved (or capturable) in an
                // explosion cause chain this API exposes, so playerId is
                // intentionally left unset here - block_explode is a world
                // event, not an actor-attributed one, and eventPlayback.js
                // doesn't need an actor to visually replay a block
                // disappearing.
                beforePermutation: snapshotPermutation(event.explodedBlockPermutation),
                afterPermutation: snapshotPermutation(event.block.permutation)
            }, event.block.dimension.id, event.block.location);
        } catch (e) {
            // fail soft
        }
    }, (cb) => world.afterEvents.blockExplode.unsubscribe(cb));

    // Player/entity interaction is a first-class event, independent of damage.
    // This uses the stable after-event so successful interactions that do not
    // cause damage are still recorded.
    subscribe(world.afterEvents.playerInteractWithEntity, (event) => {
        try {
            const player = event.player;
            const target = event.target;
            if (!player || !target || !recordingState.mobSeen.has(target.id)) return;
            push("mob_interact", {
                playerId: player.id,
                entityId: target.id,
                entityTypeId: target.typeId,
                beforeItemTypeId: event.beforeItemStack ? event.beforeItemStack.typeId : undefined,
                afterItemTypeId: event.itemStack ? event.itemStack.typeId : undefined,
                location: { ...target.location }
            }, target.dimension.id, target.location);
        } catch (e) {}
    }, (cb) => world.afterEvents.playerInteractWithEntity.unsubscribe(cb));

    // Melee-hit is recorded separately from damage. This preserves attacks
    // that connect but deal no damage and prevents the replay from depending
    // exclusively on entityHurt.
    subscribe(world.afterEvents.entityHitEntity, (event) => {
        try {
            const attacker = event.damagingEntity;
            const victim = event.hitEntity;
            if (!attacker || !victim) return;

            const attackerIsPlayer = attacker.typeId === "minecraft:player";
            const attackerIsTrackedMob = !attackerIsPlayer && recordingState.mobSeen.has(attacker.id);
            const victimIsPlayer = victim.typeId === "minecraft:player";
            const victimIsTrackedMob = !victimIsPlayer && recordingState.mobSeen.has(victim.id);

            if (!attackerIsPlayer && !attackerIsTrackedMob) return;
            if (!victimIsPlayer && !victimIsTrackedMob) return;

            let attackerWeaponTypeId;
            if (attackerIsPlayer) attackerWeaponTypeId = getMainhandTypeId(attacker);

            push("entity_hit", {
                attackerPlayerId: attackerIsPlayer ? attacker.id : undefined,
                attackerMobId: attackerIsTrackedMob ? attacker.id : undefined,
                victimPlayerId: victimIsPlayer ? victim.id : undefined,
                victimMobId: victimIsTrackedMob ? victim.id : undefined,
                attackerWeaponTypeId,
                location: { ...victim.location }
            }, victim.dimension.id, victim.location);
        } catch (e) {}
    }, (cb) => world.afterEvents.entityHitEntity.unsubscribe(cb));

    // Entity replay is deliberately restricted to the recorded mob population.
    // We do NOT record generic entitySpawn events: playback has no intentional
    // implementation for arbitrary vanilla entities, and spawning them would
    // recreate live behavior or duplicate the controlled replay-mob actors.
    subscribe(world.afterEvents.entityDie, (event) => {
        const entity = event.deadEntity;
        if (!entity) return;
        try {
            if (entity.typeId === "minecraft:player") {
                push("player_death", {
                    entityTypeId: entity.typeId,
                    entityId: entity.id,
                    playerId: entity.id,
                    location: { ...entity.location }
                }, entity.dimension.id, entity.location);
                return;
            }

            // Only supported mobs that were actually captured this recording
            // have an intentional playback representation.
            if (!recordingState.mobSeen.has(entity.id)) return;

            push("mob_death", {
                entityTypeId: entity.typeId,
                entityId: entity.id,
                location: { ...entity.location }
            }, entity.dimension.id, entity.location);
        } catch (e) {
            // fail soft
        }
    }, (cb) => world.afterEvents.entityDie.unsubscribe(cb));

    // entityRemove is intentionally not subscribed. Bedrock can remove an
    // entity because it unloads, so removal is not a replay death signal.
    // Supported mob deaths are captured only through entityDie above.

    // Compatibility: keep the optional entityHurt listener guarded so the pack remains resilient across newer API revisions; the recorded health timeline and entityHitEntity event provide the stable fallback.
    if (world.afterEvents && world.afterEvents.entityHurt && typeof world.afterEvents.entityHurt.subscribe === "function") {
        subscribe(world.afterEvents.entityHurt, (event) => {
        const entity = event.hurtEntity;
        if (!entity) return;
        try {
            const attacker = event.damageSource ? event.damageSource.damagingEntity : undefined;
            const isPlayerAttacker = attacker && attacker.typeId === "minecraft:player";
            // Mob-as-attacker capture (Mob Attack Animation pass): same
            // "only recorded when it maps to something playback can find
            // an actor for" reasoning as the player attacker capture below,
            // just for a mob puppet instead of a replay actor. Only
            // recorded when the attacker is itself a mob currently being
            // captured this session (recordingState.mobSeen), so a wild
            // mob outside the recording's scope never produces a dangling
            // reference eventPlayback.js can't resolve on playback.
            const isMobAttacker =
                attacker && !isPlayerAttacker && recordingState.mobSeen && recordingState.mobSeen.has(attacker.id);
            // Weapon typeId at the moment of the hit, only when the attacker
            // is a player (so it maps to a replay actor on playback) - used
            // to pick sword/axe/mace/trident/bare-hand swing animation.
            // getComponent("minecraft:equippable") is the same confirmed-real
            // path capture.js already uses for held-item tracking.
            let attackerWeaponTypeId;
            let isMaceSmashAttack = false;
            if (isPlayerAttacker) {
                try {
                    const equippable = attacker.getComponent("minecraft:equippable");
                    const mainhand = equippable ? equippable.getEquipmentSlot(EquipmentSlot.Mainhand) : undefined;
                    const item = mainhand ? mainhand.getItem() : undefined;
                    attackerWeaponTypeId = item ? item.typeId : undefined;
                } catch (e) {
                    attackerWeaponTypeId = undefined;
                }

                // Mace Smash Particle pass: a real vanilla mechanic (per
                // Mojang's own 1.21 changelog) - a mace attack becomes a
                // "smash attack" specifically when the wielder falls more
                // than 1.5 blocks before landing the hit, and vanilla
                // shows an explosive particle burst only for THAT case,
                // not every mace swing. attacker.isFalling ("fall
                // distance greater than 0") is a real, confirmed Script
                // API property (Microsoft's own docs), checked at the
                // exact moment of the hit - the closest honest proxy
                // available for "was this a smash attack," same
                // confirmed-signal discipline as the totem-pop detection
                // elsewhere in this file. This can't distinguish a true
                // ≥1.5-block smash from a smaller fall that still left
                // isFalling true - that imprecision is accepted, same
                // tradeoff class as totem-pop's own honesty note.
                if (attackerWeaponTypeId === "minecraft:mace") {
                    try {
                        isMaceSmashAttack = !!attacker.isFalling;
                    } catch (e) {
                        isMaceSmashAttack = false;
                    }
                }
            }
            push(entity.typeId === "minecraft:player" ? "player_damage" : "entity_damage", {
                entityTypeId: entity.typeId,
                entityId: entity.id,
                playerId: entity.typeId === "minecraft:player" ? entity.id : undefined,
                damage: event.damage,
                cause: event.damageSource ? event.damageSource.cause : undefined,
                // Attacker capture, for the attack-swing animation on playback -
                // only recorded when the attacker is itself a player (so it
                // maps to a replay actor); other causes (fall, fire, etc)
                // leave this undefined and just skip the swing on playback.
                attackerPlayerId: isPlayerAttacker ? attacker.id : undefined,
                attackerWeaponTypeId,
                isMaceSmashAttack,
                // Mob attacker (Mob Attack Animation pass) - separate field
                // from attackerPlayerId, never both set on the same event
                // (an attacker is either a player or a tracked mob, never
                // both), so eventPlayback.js can tell which actor population
                // to look the attacker up in without any ambiguity.
                attackerMobId: isMobAttacker ? attacker.id : undefined,
                location: { ...entity.location }
            }, entity.dimension.id, entity.location);
        } catch (e) {
            // fail soft
        }
        }, (cb) => world.afterEvents.entityHurt.unsubscribe(cb));


    }

    subscribe(world.afterEvents.explosion, (event) => {
        const location = explosionCenter(event);
        push("explosion", { location }, event.dimension.id, location);
    }, (cb) => world.afterEvents.explosion.unsubscribe(cb));

    subscribe(world.afterEvents.itemUse, (event) => {
        const source = event.source;
        if (!source || !source.isValid) return;
        push("item_use", {
            itemTypeId: event.itemStack ? event.itemStack.typeId : undefined,
            playerId: source.id,
            location: { ...source.location }
        }, source.dimension.id, source.location);
    }, (cb) => world.afterEvents.itemUse.unsubscribe(cb));

    return true;
}

/**
 * @returns {Array<object>} the captured events (also clears the internal buffer)
 */
export function stopEventCapture() {
    if (!state.active) return [];

    for (const unsub of state.unsubscribers) {
        try {
            unsub();
        } catch (e) {
            // fail soft
        }
    }

    state.active = false;
    state.unsubscribers = [];
    pendingInteractBefore.clear();
    const events = state.events;
    state.events = [];
    return events;
}

export function isCapturingEvents() {
    return state.active;
}


/**
 * Auxiliary mob-state capture helpers used by capture.js.
 *
 * These signals are intentionally recorded as timeline events only. Bedrock
 * does not expose supported setters for is_tamed, onfire, or villager
 * profession, so playback must not fabricate those states. Keeping the
 * events in the recording is useful for diagnostics/future API support while
 * avoiding unsupported runtime mutations.
 */
export const VILLAGER_JOB_EVENTS = {
    armorer: "armorer",
    butcher: "butcher",
    cartographer: "cartographer",
    cleric: "cleric",
    farmer: "farmer",
    fisherman: "fisherman",
    fletcher: "fletcher",
    leatherworker: "leatherworker",
    librarian: "librarian",
    mason: "mason",
    shepherd: "shepherd",
    toolsmith: "toolsmith",
    weaponsmith: "weaponsmith",
    stone_mason: "stone_mason"
};

export function recordMobTamed(mobId, location, dimensionId, ownerPlayerId) {
    if (!state.active) return;
    push("mob_tamed", { mobId, ownerPlayerId, location: { ...location } }, dimensionId, location);
}

export function recordBreedingHearts(location, dimensionId) {
    if (!state.active) return;
    push("breeding_hearts", { location: { ...location } }, dimensionId, location);
}

export function recordMobBurningStart(mobId, location, dimensionId) {
    if (!state.active) return;
    push("mob_burning_start", { mobId, location: { ...location } }, dimensionId, location);
}

export function recordMobBurningStop(mobId, location, dimensionId) {
    if (!state.active) return;
    push("mob_burning_stop", { mobId, location: { ...location } }, dimensionId, location);
}

export function recordVillagerProfession(mobId, profession, dimensionId, location) {
    if (!state.active) return;
    push("villager_profession", { mobId, profession, location: location ? { ...location } : undefined }, dimensionId, location);
}


/**
 * Particle Recording pass (Totem particle): called from capture.js's own
 * equipment RLE comparison, the moment it detects minecraft:totem_of_undying
 * disappearing from a player's mainhand or offhand slot between two
 * consecutive ticks. This is a REAL, OBSERVABLE signal (an actual
 * equipment-slot change, the same primitive already driving equipment
 * capture) rather than a guess about internal game mechanics - there is no
 * "totem activated" event in the Script API (confirmed: no such signal
 * exists in world.afterEvents), so a totem vanishing from the hand it was
 * held in is the closest real, honest proxy available. This can't
 * distinguish "totem saved the player from death" from some other reason
 * the item left that slot (dropped, moved to inventory, given away) - that
 * imprecision is a known, accepted tradeoff per the user's own explicit
 * design choice, not something this function tries to disambiguate
 * further.
 * @param {string} actorId - playerId or mobId, matching whichever population's equipment RLE this was called from
 * @param {{x:number,y:number,z:number}} location
 */
export function recordTotemPop(actorId, location, dimensionId) {
    if (!state.active) return;
    push("totem_pop", { actorId, location: { ...location } }, dimensionId, location);
}

function subscribe(signal, handler, unsubscribeFn) {
    const cb = signal.subscribe(handler);
    state.unsubscribers.push(() => unsubscribeFn(cb));
}

function push(type, data, dimensionId, location) {
    const scoped = scopedEventData(data, dimensionId || data.dimensionId, location || data.location);
    if (!scoped) return false;
    state.events.push({ tick: recordingState.tick, type, data: scoped });
    return true;
}

function explosionCenter(event) {
    try {
        if (event.impactedBlocks && event.impactedBlocks.length > 0) {
            let sx = 0;
            let sy = 0;
            let sz = 0;
            for (const loc of event.impactedBlocks) {
                sx += loc.x;
                sy += loc.y;
                sz += loc.z;
            }
            const n = event.impactedBlocks.length;
            return { x: sx / n, y: sy / n, z: sz / n };
        }
    } catch (e) {
        // fail soft
    }
    return { x: 0, y: 0, z: 0 };
}
