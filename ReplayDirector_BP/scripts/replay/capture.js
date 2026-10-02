/**
 * Replay Director - Recording Capture (Phase 3A, hardened in Phase 3I,
 * extended in the Replay Actor Animation System pass)
 *
 * Captures player state every tick into an in-memory, run-length-encoded
 * buffer: if a player's state is unchanged (within a small tolerance) from
 * the previous tick, we extend the previous entry's endTick instead of
 * storing a new one - this is the "avoid duplicate frame data / compress
 * unchanged frames" requirement from the spec, and it's what keeps a real
 * recording from blowing past storage limits once Phase 3B adds saving.
 *
 * Phase 3I additions: a per-player health component cache (avoids a fresh
 * getComponent() lookup every tick for every player - the component
 * reference itself doesn't change for the entity's lifetime), a warning
 * threshold so the UI can flag a long-running recording, and a hard tick
 * cap as a last-resort safety net against a forgotten recording growing
 * unbounded in memory.
 *
 * Animation System pass additions (all confirmed-real Script API data,
 * nothing guessed):
 * - isOnGround / isClimbing / isFalling: confirmed stable Player
 *   properties (added Bedrock 1.20.10) - drives jump/fall/land/climb
 *   poses from real physics state instead of inferring them from velocity.
 * - heldItemTypeId: read once per tick via the mainhand equipment slot -
 *   drives held-item pose (bow/crossbow/trident/shield/eating/drinking
 *   are all distinguished by typeId + isUsingItem, not guessed).
 * - isUsingItem: whether the player is mid-use of a chargeable/consumable
 *   item this tick (derived from itemStartUse/itemStopUse/itemUse events
 *   below, since there's no direct per-tick "is using" getter) - this is
 *   what actually drives eating/drinking/bow-draw/shield-block duration,
 *   not a guess at animation timing.
 *
 * NOT CAPTURED (confirmed no real API for it, not guessed at):
 * - hunger/food level - no confirmed Script API getter.
 * - Separate head-vs-body rotation for players - Player.getRotation()
 *   documents x/y as head tilt/body rotation combined for players (there
 *   is no second, independent head-only rotation exposed for a player as
 *   seen by others) - the visual head/body split on playback instead
 *   derives a head/body offset from this one recorded rotation on the
 *   client side (see actors.js's Replay Actor Improvements pass notes),
 *   using the engine's own body-yaw-lag query rather than a second
 *   captured value that doesn't exist.
 * - Continuous "mining in progress" - no confirmed per-tick mining/using
 *   getter exists; only the discrete playerBreakBlock completion event
 *   does (already captured as a world event), so mining is animated as a
 *   brief swing pulse at that moment, same honest pattern as attack swing.
 *
 * Armor & Held Item Replay pass (confirmed-real Script API data only, same
 * discipline as above):
 * - Armor (helmet/chestplate/leggings/boots) and both hands (mainhand +
 *   offhand) are read every tick via the same cached
 *   minecraft:equippable component getHeldItemTypeId() already used,
 *   through the confirmed EntityEquippableComponent.getEquipmentSlot() ->
 *   EquipmentSlot.getItem() path - see buildEquipmentSnapshot() below.
 * - Each slot's ItemStack is serialized (typeId, amount, and - only when
 *   actually present on that stack - durability damage via the confirmed
 *   ItemStack.getComponent("minecraft:durability"), enchantments via the
 *   confirmed ItemStack.getComponent("minecraft:enchantable").
 *   getEnchantments(), and a custom nameTag via the confirmed
 *   ItemStack.nameTag) - see snapshotItemStack() below.
 * - Visual armor overlays are not captured. The replay stores the supported
 *   item type, durability, enchantments, and custom name data without adding
 *   extra armor visual effects.
 */

import { world, system, EquipmentSlot } from "@minecraft/server";
import { recordingState, resetRecordingState } from "./recordingState.js";
import { rdLog, rdWarn } from "../core/debugLog.js";
import { recordMobTamed, recordBreedingHearts, recordMobBurningStart, recordMobBurningStop, recordVillagerProfession, VILLAGER_JOB_EVENTS } from "./events.js";
import { isReplayProjectileType } from "./mobSupport.js";
import { recordTotemPop } from "./events.js";

const POSITION_EPSILON = 0.02;
const ROTATION_EPSILON = 0.5;
const VELOCITY_EPSILON = 0.02;

/**
 * Mob capture scope: independent from the fixed 62x62x62 world snapshot.
 * The mob radius is intentionally larger (62 blocks) so mob recording can
 * cover a wider scene without enlarging or changing the world snapshot.
 * The bound is fixed at recording start and does not follow the director.
 */
const MOB_RADIUS = 62;
const MOB_POSITION_EPSILON = 0.02;
const MOB_ROTATION_EPSILON = 0.5;

export const PROJECTILE_TYPE_IDS = new Set([
    "minecraft:arrow","minecraft:trident","minecraft:snowball","minecraft:egg",
    "minecraft:ender_pearl","minecraft:splash_potion","minecraft:lingering_potion",
    "minecraft:fireball","minecraft:small_fireball","minecraft:wither_skull",
    "minecraft:wither_skull_dangerous","minecraft:shulker_bullet","minecraft:dragon_fireball"
]);

function isCapturableAmbientEntity(candidate) {
    if (!candidate || !candidate.isValid) return false;
    try {
        if (candidate.matches({ families: ["mob"] })) return true;
    } catch (e) {
        // Keep checking explicit projectile identifiers below.
    }
    // Only projectiles with a dedicated visual replay puppet are captured.
    // Other projectile runtime entities remain excluded rather than being
    // pushed into the mob stream and later failing to spawn.
    return isReplayProjectileType(candidate.typeId);
}

export const WARNING_TICK_THRESHOLD = 24000; // 20 minutes - UI can start showing a "this is a long recording" note
export const HARD_TICK_CAP = 72000; // 1 hour - last-resort safety net, not an expected normal use case

/** @type {Map<string, import("@minecraft/server").EntityHealthComponent>} playerId -> cached health component for this recording session */
const healthComponentCache = new Map();

/** @type {Map<string, import("@minecraft/server").EntityEquippableComponent>} playerId -> cached equippable component for this recording session */
const equippableComponentCache = new Map();

/** @type {Map<string, boolean>} playerId -> whether they're currently mid-use of an item (set/cleared by itemStartUse/itemStopUse below) */
const usingItemState = new Map();

/** @type {Array<() => void>} unsubscribe functions for the item-use tracking subscriptions, active only while recording */
let itemUseUnsubscribers = [];

/** @type {{dimensionId:string, from:object, to:object}|undefined} the bounded region mobs are captured within for the current recording session - set once at startRecording, matching snapshot.js's own bounded-region approach */
let mobCaptureBounds;
let mobLifecycleUnsubscribers = [];

/**
 * @param {import("@minecraft/server").Player} director
 * @returns {boolean} whether recording actually started
 */
/**
 * @param {import("@minecraft/server").Player} director
 * @param {{id:string, index:number}} allocated - from storage.js's allocateReplayId(), generated up front so the world snapshot's structure can be named after this replay's real id right away (see replayMenu.js's Start Recording handler)
 */
export function startRecording(director, allocated) {
    if (recordingState.active) return false;

    resetRecordingState();
    healthComponentCache.clear();
    equippableComponentCache.clear();
    usingItemState.clear();
    recordingState.active = true;
    recordingState.startedBy = director.id;
    recordingState.recordingDimensionId = director.dimension.id;
    recordingState.tick = 0;
    recordingState.pendingReplayId = allocated;

    // Mob capture scope (Record & Replay Mobs pass): a fixed bounding box
    // around the director's location AT RECORDING START, same "snapshot a
    // bound once, don't keep re-centering it" approach snapshot.js already
    // uses for its own block-snapshot region - this deliberately does NOT
    // follow the director around during recording, so what counts as
    // "in scope" is stable and predictable for the whole session, matching
    // snapshot.js's own bounded region.
    const center = director.location;
    mobCaptureBounds = {
        dimensionId: director.dimension.id,
        from: { x: center.x - MOB_RADIUS, y: center.y - MOB_RADIUS, z: center.z - MOB_RADIUS },
        to: { x: center.x + MOB_RADIUS, y: center.y + MOB_RADIUS, z: center.z + MOB_RADIUS }
    };
    recordingState.recordingBounds = {
        dimensionId: mobCaptureBounds.dimensionId,
        from: { ...mobCaptureBounds.from },
        to: { ...mobCaptureBounds.to }
    };

    itemUseUnsubscribers = subscribeItemUseTracking();
    mobLifecycleUnsubscribers = subscribeMobLifecycleTracking();

    recordingState.intervalId = system.runInterval(() => {
        captureTick();
    }, 1);

    return true;
}

/** Tracks isUsingItem per player from the real start/stop-charging events - not a per-tick guess, this is exactly what the engine itself fires for chargeable/consumable item use (bow draw, shield raise, eating, drinking, etc). */
function subscribeItemUseTracking() {
    const unsubs = [];

    const onStart = (event) => {
        if (event.source) usingItemState.set(event.source.id, true);
    };
    const onStop = (event) => {
        if (event.source) usingItemState.set(event.source.id, false);
    };

    world.afterEvents.itemStartUse.subscribe(onStart);
    unsubs.push(() => world.afterEvents.itemStartUse.unsubscribe(onStart));

    world.afterEvents.itemStopUse.subscribe(onStop);
    unsubs.push(() => world.afterEvents.itemStopUse.unsubscribe(onStop));

    world.afterEvents.itemCompleteUse.subscribe(onStop);
    unsubs.push(() => world.afterEvents.itemCompleteUse.unsubscribe(onStop));

    world.afterEvents.itemReleaseUse.subscribe(onStop);
    unsubs.push(() => world.afterEvents.itemReleaseUse.unsubscribe(onStop));

    return unsubs;
}

/**
 * @returns {{frameCount:number, playerCount:number, entryCount:number, approxBytes:number}|undefined}
 */

function subscribeMobLifecycleTracking() {
    const unsubs = [];
    const recordRemoval = (id, reason) => {
        if (!id || !recordingState.mobSeen.has(id)) return;
        if (!recordingState.mobDespawnTick.has(id)) {
            recordingState.mobDespawnTick.set(id, recordingState.tick);
            recordingState.mobDespawnReason.set(id, reason);
        }
    };
    const onDie = (event) => { if (event.deadEntity) recordRemoval(event.deadEntity.id, "death"); };
    const onRemove = (event) => { if (event.removedEntityId) recordRemoval(event.removedEntityId, "remove"); };
    world.afterEvents.entityDie.subscribe(onDie);
    world.afterEvents.entityRemove.subscribe(onRemove);
    unsubs.push(() => world.afterEvents.entityDie.unsubscribe(onDie));
    unsubs.push(() => world.afterEvents.entityRemove.unsubscribe(onRemove));
    return unsubs;
}

export function stopRecording() {
    if (!recordingState.active) return undefined;

    if (recordingState.intervalId !== undefined) {
        system.clearRun(recordingState.intervalId);
    }

    for (const unsub of itemUseUnsubscribers) {
        try {
            unsub();
        } catch (e) {
            // fail soft
        }
    }
    itemUseUnsubscribers = [];
    for (const unsub of mobLifecycleUnsubscribers) {
        try { unsub(); } catch (e) {}
    }
    mobLifecycleUnsubscribers = [];

    const stats = summarize();
    recordingState.active = false;
    healthComponentCache.clear();
    equippableComponentCache.clear();
    usingItemState.clear();
    mobCaptureBounds = undefined;
    return stats;
}

export function isRecording() {
    return recordingState.active;
}

export function getElapsedTicks() {
    return recordingState.tick;
}

export function hasReachedHardCap() {
    return recordingState.tick >= HARD_TICK_CAP;
}

function captureTick() {
    recordingState.tick++;

    // Last-resort safety net: stop growing the buffer past the hard cap.
    // The interval keeps running (so Stop Recording still works normally
    // and saves whatever was captured) - this just stops adding more.
    if (recordingState.tick > HARD_TICK_CAP) {
        return;
    }

    for (const player of world.getAllPlayers()) {
        if (!player.isValid) continue;
        // Player replay is segmented by dimension: only players in the
        // recording's starting dimension are sampled. A dimension change
        // therefore creates a safe gap instead of ever mapping Nether/End
        // coordinates into the director's playback dimension.
        if (player.dimension.id !== recordingState.recordingDimensionId) continue;

        recordingState.playerNames.set(player.id, player.name);

        const state = buildState(player);
        const last = recordingState.lastState.get(player.id);

        if (last && statesMatch(last, state)) {
            // Unchanged - extend the previous entry instead of storing a new one.
            const entries = recordingState.buffer.get(player.id);
            if (entries && entries.length > 0) {
                entries[entries.length - 1].endTick = recordingState.tick;
                continue;
            }
        }

        if (!recordingState.buffer.has(player.id)) {
            recordingState.buffer.set(player.id, []);
        }
        recordingState.buffer.get(player.id).push({
            startTick: recordingState.tick,
            endTick: recordingState.tick,
            state
        });
        recordingState.lastState.set(player.id, state);
    }

    // Equipment: a separate RLE pass over the same player list, on its own
    // independent buffer/change-cadence (see recordingState.js) - not
    // merged into the loop above so an armor/held-item change never forces
    // a new position entry (and vice versa).
    for (const player of world.getAllPlayers()) {
        if (!player.isValid) continue;
        if (player.dimension.id !== recordingState.recordingDimensionId) continue;

        const equipment = buildEquipmentSnapshot(player);
        const lastEquipment = recordingState.lastEquipment.get(player.id);

        // Particle Recording pass (Totem particle): real, observable signal
        // - minecraft:totem_of_undying was in mainhand or offhand on the
        // PREVIOUS tick and is no longer there on this one. Checked here,
        // not folded into equipmentSnapshotsMatch below, since this needs
        // to fire even on ticks where the RLE comparison finds OTHER
        // slots unchanged too (a totem pop is itself the equipment
        // change that would make lastEquipment/equipment differ, so this
        // only ever needs lastEquipment to exist and mismatch on
        // mainhand/offhand specifically - not gated on the overall
        // equipmentSnapshotsMatch() result at all, since that's about
        // deciding the RLE entry boundary, a separate concern).
        if (lastEquipment) {
            for (const handKey of ["mainhand", "offhand"]) {
                const had = lastEquipment[handKey];
                const has = equipment[handKey];
                if (had && had.typeId === "minecraft:totem_of_undying" && (!has || has.typeId !== "minecraft:totem_of_undying")) {
                    recordTotemPop(player.id, player.location, player.dimension.id);
                }
            }
        }

        if (lastEquipment && equipmentSnapshotsMatch(lastEquipment, equipment)) {
            const entries = recordingState.equipmentBuffer.get(player.id);
            if (entries && entries.length > 0) {
                entries[entries.length - 1].endTick = recordingState.tick;
                continue;
            }
        }

        if (!recordingState.equipmentBuffer.has(player.id)) {
            recordingState.equipmentBuffer.set(player.id, []);
        }
        recordingState.equipmentBuffer.get(player.id).push({
            startTick: recordingState.tick,
            endTick: recordingState.tick,
            equipment
        });
        recordingState.lastEquipment.set(player.id, equipment);
    }

    captureMobsTick();
}

/**
 * Mob capture pass (Record & Replay Mobs pass): same RLE approach as the
 * player loop above (position/rotation only - mobs don't have equipment,
 * XP, or held-item state worth recording for a first pass), scoped to
 * mobCaptureBounds and to mobSupport.js's allowlist. Entirely separate
 * from the player buffer/cursor system, same "different population,
 * different lifecycle" reasoning as recordingState.js's mobBuffer doc
 * comment explains.
 *
 * Uses dimension.getEntities({location, maxDistance}) rather than a
 * manual bounding-box filter over world.getAllPlayers()-style iteration -
 * this is the confirmed real Script API shape for a scoped entity query
 * (an entity-family/type filter plus a location+radius), and naturally
 * excludes players (family "mob" would also work, but filtering by our
 * own supported-typeId allowlist immediately afterward makes the family
 * filter here belt-and-suspenders rather than load-bearing).
 */
function captureMobsTick() {
    if (!mobCaptureBounds) return;

    let dimension;
    try {
        dimension = world.getDimension(mobCaptureBounds.dimensionId);
    } catch (e) {
        return; // fail soft - dimension somehow unavailable this tick
    }

    const center = {
        x: (mobCaptureBounds.from.x + mobCaptureBounds.to.x) / 2,
        y: (mobCaptureBounds.from.y + mobCaptureBounds.to.y) / 2,
        z: (mobCaptureBounds.from.z + mobCaptureBounds.to.z) / 2
    };

    let candidates;
    try {
        candidates = dimension.getEntities({
            location: center,
            maxDistance: MOB_RADIUS,
            // No `families` inclusion filter anymore (Ambient Projectile
            // Capture pass) - projectiles aren't reliably one shared
            // family the way mobs are, so eligibility is now decided by
            // isCapturableAmbientEntity() in the loop below instead. This
            // query is intentionally broader (every non-excluded entity in
            // range) and relies entirely on that per-candidate check to
            // scope down to "mobs and known projectiles" - see that
            // function's own header.
            excludeFamilies: ["player", "replay_actor"],
            // Puppets get excluded above via their own "replay_mob" family
            // (see mob_*.json's type_family), but a generic fallback mob
            // (mobActors.js's spawnMobActor, when no puppet is registered)
            // is the REAL vanilla type and can't carry a custom family -
            // it's excluded by tag instead, matching the "replay_generic_mob"
            // tag spawnMobActor stamps on it. Without this, a second
            // director recording while someone else's replay is actively
            // playing back could otherwise re-capture an in-progress
            // generic mob playback as if it were a real, freshly-spawned mob.
            excludeTags: ["replay_generic_mob"]
        });
    } catch (e) {
        rdWarn(`captureMobsTick: dimension.getEntities() threw - skipping mob capture this tick.`, e);
        return;
    }

    const seenThisTick = new Set();

    for (const mob of candidates) {
        if (!isCapturableAmbientEntity(mob)) continue;
        // No allowlist gate here anymore (Generic Ambient Mob Capture pass) -
        // every mob-family entity and known projectile in range is
        // recorded; mobActors.js decides puppet-vs-generic spawn at
        // playback time based on mobSupport.js.

        const isFirstSight = !recordingState.mobSeen.has(mob.id);
        seenThisTick.add(mob.id);
        recordingState.mobTypeIds.set(mob.id, mob.typeId);
        recordingState.mobSeen.add(mob.id);

        // Projectile capture is isolated from mob-only state/equipment/status
        // logic. It shares the hardened RLE transform/lifecycle buffer so
        // playback gets the same timing and seek behavior as mobs.
        if (isReplayProjectileType(mob.typeId)) {
            const state = buildMobState(mob);
            const last = recordingState.mobLastState.get(mob.id);
            if (last && mobStatesMatch(last, state)) {
                const entries = recordingState.mobBuffer.get(mob.id);
                if (entries && entries.length > 0) {
                    entries[entries.length - 1].endTick = recordingState.tick;
                    continue;
                }
            }
            if (!recordingState.mobBuffer.has(mob.id)) {
                recordingState.mobBuffer.set(mob.id, []);
            }
            recordingState.mobBuffer.get(mob.id).push({
                startTick: recordingState.tick,
                endTick: recordingState.tick,
                state
            });
            recordingState.mobLastState.set(mob.id, state);
            continue;
        }

        // Baby/adult state (Generic Ambient Mob Capture pass): captured
        // once, at first sight only - EntityIsBabyComponent is a real,
        // confirmed Script API component (its mere presence on
        // getComponent("minecraft:is_baby") means the entity is currently
        // a baby; there is no settable/writable equivalent exposed by the
        // Script API - see mobActors.js's spawnMobActor for how this is
        // applied, honestly, as a visual-scale approximation rather than a
        // claimed full baby-model swap).
        if (isFirstSight) {
            try {
                const isBaby = !!mob.getComponent("minecraft:is_baby");
                recordingState.mobIsBaby.set(mob.id, isBaby);
                // Breeding Particles pass: a baby captured for the first
                // time is a reasonable proxy for "breeding just happened
                // here" - not a precise capture of the real breeding
                // moment (which happens slightly earlier, before this
                // baby existed as its own entity), but close enough to
                // give a satisfying visual cue at roughly the right place
                // and time without needing a dedicated "entities bred"
                // event (none is confirmed to exist in the Script API).
                if (isBaby) {
                    recordBreedingHearts(mob.location, mob.dimension.id);
                }
            } catch (e) {
                // fail soft - treat as adult (default) if the component lookup itself throws
            }
        }

        // Taming/burning state transitions (Taming + Burning Particles
        // passes) - throttled to every 3rd tick (not every single tick)
        // as extra headroom on top of the trade-gesture throttling fix
        // above, given how much per-mob per-tick cost this loop already
        // carries - a taming/ignition moment doesn't need frame-perfect
        // detection to still look right once replayed, so a couple
        // ticks of detection latency costs nothing visible while helping
        // protect the actual position/rotation capture below (which DOES
        // need to run every tick) from falling behind.
        if (recordingState.tick % 3 === 0) {
            try {
                const tameable = mob.getComponent("minecraft:tameable");
                const isTamedNow = !!(tameable && tameable.isTamed);
                const wasTamedBefore = recordingState.mobWasTamed.get(mob.id) || false;
                if (isTamedNow && !wasTamedBefore) {
                    recordMobTamed(mob.id, mob.location, mob.dimension.id, tameable.tamedToPlayerId);
                }
                recordingState.mobWasTamed.set(mob.id, isTamedNow);
            } catch (e) {
                // fail soft - this mob type just never gets a taming event, no different from before this pass existed
            }

            try {
                const isBurningNow = !!mob.getComponent("minecraft:onfire");
                const wasBurningBefore = recordingState.mobWasBurning.get(mob.id) || false;
                if (isBurningNow && !wasBurningBefore) {
                    recordMobBurningStart(mob.id, mob.location, mob.dimension.id);
                } else if (!isBurningNow && wasBurningBefore) {
                    recordMobBurningStop(mob.id, mob.location, mob.dimension.id);
                }
                recordingState.mobWasBurning.set(mob.id, isBurningNow);
            } catch (e) {
                // fail soft
            }

            // Villager profession (Villager Profession Replay pass v2) -
            // corrected after finding ReplayCraft's own shipped code: a
            // villager's CURRENT profession is directly, reliably
            // readable via entity.getComponent("minecraft:type_family")
            // .getTypeFamilies() - profession names (farmer, librarian,
            // stone_mason, ...) are literally included as family tags,
            // no heuristic job-site-block-placement guessing needed at
            // all (the previous version of this feature). Compared
            // tick-to-tick (well, every-3rd-tick, same throttling as
            // taming/burning above) the same way as every other state
            // transition in this pass, so a profession CHANGE mid-
            // recording (not just the initial one) is also captured
            // correctly.
            if ((mob.typeId === "minecraft:villager_v2" || mob.typeId === "minecraft:villager")) {
                try {
                    const typeFamily = mob.getComponent("minecraft:type_family");
                    const families = typeFamily && typeof typeFamily.getTypeFamilies === "function" ? typeFamily.getTypeFamilies() : [];
                    const jobFamily = families.find((f) => Object.prototype.hasOwnProperty.call(VILLAGER_JOB_EVENTS, f));
                    const currentProfession = jobFamily || "none";
                    const lastProfession = recordingState.mobLastProfession.get(mob.id);
                    if (jobFamily && currentProfession !== lastProfession) {
                        recordVillagerProfession(mob.id, VILLAGER_JOB_EVENTS[jobFamily], mob.dimension.id, mob.location);
                    }
                    recordingState.mobLastProfession.set(mob.id, currentProfession);
                } catch (e) {
                    // fail soft - this villager just never gets a profession-change event, no different from before this pass existed
                }
            }
        }

        const state = buildMobState(mob);
        const last = recordingState.mobLastState.get(mob.id);

        if (last && mobStatesMatch(last, state)) {
            const entries = recordingState.mobBuffer.get(mob.id);
            if (entries && entries.length > 0) {
                entries[entries.length - 1].endTick = recordingState.tick;
                continue;
            }
        }

        if (!recordingState.mobBuffer.has(mob.id)) {
            recordingState.mobBuffer.set(mob.id, []);
        }
        recordingState.mobBuffer.get(mob.id).push({
            startTick: recordingState.tick,
            endTick: recordingState.tick,
            state
        });
        recordingState.mobLastState.set(mob.id, state);

        // Equipment (Mob Equipment Sync pass): same independent-RLE-stream
        // approach as the player equipment pass in captureTick above, using
        // the exact same minecraft:equippable component path - this is a
        // generic ItemStack-container component that any entity type may
        // or may not have, not something player-specific, so reusing
        // buildEquipmentSnapshotFor() (factored out of the player-only
        // buildEquipmentSnapshot below) here is the confirmed-correct
        // approach, not a guess. A mob type with no minecraft:equippable
        // component (e.g. a cow) naturally gets an all-empty snapshot
        // every tick, which RLE-collapses into one entry and costs nothing.
        const equipment = buildMobEquipmentSnapshot(mob);
        const lastEquipment = recordingState.mobLastEquipment.get(mob.id);

        // Particle Recording pass (Totem particle): same real-signal
        // detection as the player equipment loop above, over mobs instead
        // - a supported mob type (zombie, skeleton - see mobSupport.js)
        // can pick up and hold a totem like any other mainhand/offhand
        // item, so this is the same honest, observable check, just for
        // the mob population.
        if (lastEquipment) {
            for (const handKey of ["mainhand", "offhand"]) {
                const had = lastEquipment[handKey];
                const has = equipment[handKey];
                if (had && had.typeId === "minecraft:totem_of_undying" && (!has || has.typeId !== "minecraft:totem_of_undying")) {
                    recordTotemPop(mob.id, mob.location);
                }
            }
        }

        if (!(lastEquipment && equipmentSnapshotsMatch(lastEquipment, equipment))) {
            if (!recordingState.mobEquipmentBuffer.has(mob.id)) {
                recordingState.mobEquipmentBuffer.set(mob.id, []);
            }
            recordingState.mobEquipmentBuffer.get(mob.id).push({
                startTick: recordingState.tick,
                endTick: recordingState.tick,
                equipment
            });
            recordingState.mobLastEquipment.set(mob.id, equipment);
        } else {
            const entries = recordingState.mobEquipmentBuffer.get(mob.id);
            if (entries && entries.length > 0) {
                entries[entries.length - 1].endTick = recordingState.tick;
            }
        }

        // Status (Ambient Status Effects pass): onFire and isTamed, tracked
        // the same independent-RLE-stream way as equipment above - see
        // buildMobStatusSnapshot for the real, confirmed APIs behind each
        // field. Kept OUT of the position state object (buildMobState)
        // deliberately - position gets smoothly interpolated between
        // frames (updateMobActorTransformInterpolated), but a boolean like
        // "on fire" must snap discretely, never blend, so mixing it into
        // the lerped fields would need special-casing there instead of
        // being naturally correct here for free.
        const status = buildMobStatusSnapshot(mob);
        const lastStatus = recordingState.mobLastStatus.get(mob.id);
        if (!(lastStatus && mobStatusesMatch(lastStatus, status))) {
            if (!recordingState.mobStatusBuffer.has(mob.id)) {
                recordingState.mobStatusBuffer.set(mob.id, []);
            }
            recordingState.mobStatusBuffer.get(mob.id).push({
                startTick: recordingState.tick,
                endTick: recordingState.tick,
                status
            });
            recordingState.mobLastStatus.set(mob.id, status);
        } else {
            const entries = recordingState.mobStatusBuffer.get(mob.id);
            if (entries && entries.length > 0) {
                entries[entries.length - 1].endTick = recordingState.tick;
            }
        }
    }

    // Close a mob that genuinely leaves the fixed 62-block capture scope.
    // A short grace period prevents a transient query miss from being treated
    // as a lifecycle change. Scope exit is NOT death, so playback removes it
    // silently rather than running a vanilla death sequence.
    for (const mobId of recordingState.mobSeen) {
        if (seenThisTick.has(mobId)) {
            recordingState.mobMissingTicks.delete(mobId);
            continue;
        }
        if (recordingState.mobDespawnTick.has(mobId)) continue;
        const missing = (recordingState.mobMissingTicks.get(mobId) || 0) + 1;
        recordingState.mobMissingTicks.set(mobId, missing);
        if (missing >= 3) {
            recordingState.mobDespawnTick.set(mobId, recordingState.tick - 2);
            recordingState.mobDespawnReason.set(mobId, "scope_exit");
        }
    }
}

function buildMobState(mob) {
    const loc = mob.location;
    const rot = mob.getRotation();
    let health;
    try {
        const healthComponent = mob.getComponent("minecraft:health");
        health = healthComponent ? round(healthComponent.currentValue, 2) : undefined;
    } catch (e) {
        health = undefined;
    }

    let viewX;
    let viewY;
    let viewZ;
    try {
        const view = mob.getViewDirection();
        viewX = round(view.x, 4);
        viewY = round(view.y, 4);
        viewZ = round(view.z, 4);
    } catch (e) {}

    return {
        dimensionId: mob.dimension.id,
        x: round(loc.x, 2),
        y: round(loc.y, 2),
        z: round(loc.z, 2),
        yaw: round(rot.y, 1),
        pitch: round(rot.x, 1),
        health,
        viewX,
        viewY,
        viewZ
    };
}

function mobStatesMatch(a, b) {
    return (
        Math.abs(a.x - b.x) < MOB_POSITION_EPSILON &&
        Math.abs(a.y - b.y) < MOB_POSITION_EPSILON &&
        Math.abs(a.z - b.z) < MOB_POSITION_EPSILON &&
        Math.abs(a.yaw - b.yaw) < MOB_ROTATION_EPSILON &&
        Math.abs(a.pitch - b.pitch) < MOB_ROTATION_EPSILON &&
        (a.health === undefined || b.health === undefined || Math.abs(a.health - b.health) < 0.01) &&
        (a.viewX === undefined || b.viewX === undefined || Math.abs(a.viewX - b.viewX) < 0.01) &&
        (a.viewY === undefined || b.viewY === undefined || Math.abs(a.viewY - b.viewY) < 0.01) &&
        (a.viewZ === undefined || b.viewZ === undefined || Math.abs(a.viewZ - b.viewZ) < 0.01)
    );
}

function getHealth(player) {
    try {
        let component = healthComponentCache.get(player.id);
        if (!component) {
            component = player.getComponent("minecraft:health");
            if (component) healthComponentCache.set(player.id, component);
        }
        return component ? component.currentValue : undefined;
    } catch (e) {
        return undefined;
    }
}

/** @returns {string|undefined} the typeId of whatever's in the player's mainhand this tick, or undefined if empty/unavailable */
function getHeldItemTypeId(player) {
    try {
        let equippable = equippableComponentCache.get(player.id);
        if (!equippable) {
            equippable = player.getComponent("minecraft:equippable");
            if (equippable) equippableComponentCache.set(player.id, equippable);
        }
        if (!equippable) return undefined;

        const mainhand = equippable.getEquipmentSlot(EquipmentSlot.Mainhand);
        if (!mainhand || !mainhand.hasItem()) return undefined;

        const item = mainhand.getItem();
        return item ? item.typeId : undefined;
    } catch (e) {
        return undefined;
    }
}

/**
 * Maps our own snapshot field names to real EquipmentSlot enum members.
 *
 * Uses the supported @minecraft/server API for this operation.
 * (the exact version this manifest depends on, 2.1.0): the enum's actual
 * members are CAPITALIZED - EquipmentSlot.Head === "Head",
 * EquipmentSlot.Chest === "Chest", EquipmentSlot.Mainhand === "Mainhand",
 * etc. A previous pass here believed the opposite (lowercase) based on
 * incorrect assumptions, which was itself the bug - EquipmentSlot.head/
 * .mainhand (lowercase) do NOT exist on this enum and silently evaluate
 * to undefined, which broke armor/held-item capture entirely: every
 * getEquipmentSlot(undefined) call failed inside this file's own
 * try/catch, so every slot always read back as empty, every tick's
 * snapshot was identical (all-empty) to the last, and the recording-side
 * RLE never detected a "change" to write a new equipment entry - which is
 * exactly why playback's updateActorEquipment logged "snapshot unchanged
 * since last apply - skipping" on literally every tick, even across a
 * recorded elytra/armor change, and why nothing ever showed up on the
 * actor despite the exact same /replaceitem mechanism working fine when
 * driven manually from the Armor/Held Item menu (which never goes
 * through this enum lookup at all).
 * Matches the same fix needed on the playback side in actors.js's
 * EQUIPMENT_SLOT_MAP, if that file has its own separate copy of this enum
 * mapping - see that file's own comment.
 */
const EQUIPMENT_SLOT_KEYS = {
    head: EquipmentSlot.Head,
    chest: EquipmentSlot.Chest,
    legs: EquipmentSlot.Legs,
    feet: EquipmentSlot.Feet,
    mainhand: EquipmentSlot.Mainhand,
    offhand: EquipmentSlot.Offhand
};

/**
 * Serializes one worn/held ItemStack into a plain object that can be
 * stored in a replay's frame data and later handed to
 * EntityEquippableComponent.setEquipment() on a Replay Actor. Every field
 * comes from a confirmed ItemStack API - see the file header's Armor &
 * Held Item Replay pass notes for exactly what is and isn't captured.
 * @param {import("@minecraft/server").ItemStack|undefined} item
 * @returns {object|undefined} undefined means "slot is empty"
 */
function snapshotItemStack(item) {
    if (!item) return undefined;

    const snapshot = { typeId: item.typeId, amount: item.amount };

    try {
        if (item.nameTag) snapshot.nameTag = item.nameTag;
    } catch (e) {
        // fail soft - nameTag read is documented-safe, but stay consistent with the rest of this file
    }

    try {
        const durability = item.getComponent("minecraft:durability");
        if (durability) snapshot.durabilityDamage = durability.damage;
    } catch (e) {
        // fail soft - item has no durability component, or API unavailable
    }

    try {
        const enchantable = item.getComponent("minecraft:enchantable");
        if (enchantable) {
            const list = enchantable.getEnchantments();
            if (list && list.length > 0) {
                snapshot.enchantments = list.map((e) => ({ type: e.type.id, level: e.level }));
            }
        }
    } catch (e) {
        // fail soft - item has no enchantable component, or API unavailable
    }

    return snapshot;
}

/**
 * Reads every armor slot plus both hands for a player this tick, all
 * through the same cached minecraft:equippable component getHeldItemTypeId()
 * already uses. Returns a plain object keyed by slot name
 * (head/chest/legs/feet/mainhand/offhand), each value either undefined
 * (empty slot) or a snapshotItemStack() result.
 * @param {import("@minecraft/server").Player} player
 * @returns {object}
 */
function buildEquipmentSnapshot(player) {
    const snapshot = {};
    try {
        let equippable = equippableComponentCache.get(player.id);
        if (!equippable) {
            equippable = player.getComponent("minecraft:equippable");
            if (equippable) equippableComponentCache.set(player.id, equippable);
        }
        if (!equippable) {
            rdWarn(`buildEquipmentSnapshot: player "${player.name}" has no "minecraft:equippable" component (unexpected - all players should have this natively).`);
            return snapshot;
        }

        for (const [key, equipmentSlot] of Object.entries(EQUIPMENT_SLOT_KEYS)) {
            try {
                const slot = equippable.getEquipmentSlot(equipmentSlot);
                snapshot[key] = slot && slot.hasItem() ? snapshotItemStack(slot.getItem()) : undefined;
            } catch (e) {
                snapshot[key] = undefined;
            }
        }

        // One-time-per-recording-tick confirmation that capture is producing
        // real data - lets the recording side of the pipeline be ruled in/out
        // independently from the playback side (actors.js).
        const nonEmpty = Object.entries(snapshot).filter(([, v]) => v).map(([k, v]) => `${k}=${v.typeId}`);
        if (nonEmpty.length > 0) {
            rdLog(`buildEquipmentSnapshot: player "${player.name}" recorded this tick: ${nonEmpty.join(", ")}`);
        }
    } catch (e) {
        // fail soft - snapshot stays whatever slots were read before the failure
    }
    return snapshot;
}

/** True if two item snapshots (either may be undefined, meaning "empty slot") describe the same worn/held item - shallow field comparison, enchantments compared by JSON since order is stable per stack. */
function itemSnapshotsMatch(a, b) {
    if (a === b) return true;
    if (!a || !b) return false;
    return (
        a.typeId === b.typeId &&
        a.amount === b.amount &&
        a.nameTag === b.nameTag &&
        a.durabilityDamage === b.durabilityDamage &&
        JSON.stringify(a.enchantments || []) === JSON.stringify(b.enchantments || [])
    );
}

/** True if every slot in two equipment snapshots matches - used to decide whether to extend the previous RLE entry or start a new one. Iterates our own snapshot field names (head/chest/legs/feet/mainhand/offhand), NOT the EquipmentSlot enum values - those are only used to call getEquipmentSlot(), never as object keys into a snapshot. */
function equipmentSnapshotsMatch(a, b) {
    for (const key of Object.keys(EQUIPMENT_SLOT_KEYS)) {
        if (!itemSnapshotsMatch(a[key], b[key])) return false;
    }
    return true;
}

/**
 * Mob equipment capture (Mob Equipment Sync pass) - same confirmed
 * minecraft:equippable -> getEquipmentSlot() -> ItemStack path as
 * buildEquipmentSnapshot() above, generalized to any entity rather than
 * specifically a Player. This is the correct, confirmed generalization,
 * not a guess: EntityEquippableComponent is documented as available on
 * "entities," not specifically players, and is exactly the component
 * Mojang's own vanilla mobs with equipment (zombies, skeletons, piglins,
 * wolves, etc.) declare in their own behavior pack JSON to support
 * picked-up/spawned-with armor and held items - that's precisely why a
 * recorded zombie's netherite armor or totem is readable here at all.
 *
 * A mob type with no minecraft:equippable component (e.g. cow, pig - see
 * mobSupport.js's v1 list) simply has `equippable` come back undefined
 * here, same as any entity lacking the component - this returns an
 * all-empty snapshot rather than forcing/fabricating equipment data that
 * was never real, honoring "respect each mob's natural behavior instead
 * of forcing a generic implementation onto every entity."
 * @param {import("@minecraft/server").Entity} mob
 * @returns {object}
 */
function buildMobEquipmentSnapshot(mob) {
    const snapshot = {};
    try {
        let equippable = equippableComponentCache.get(mob.id);
        if (!equippable) {
            equippable = mob.getComponent("minecraft:equippable");
            if (equippable) equippableComponentCache.set(mob.id, equippable);
        }
        if (!equippable) {
            // Not a warning - this is the expected, correct outcome for
            // mob types that genuinely have no equipment slots at all
            // (cow, pig), not a failure to diagnose.
            return snapshot;
        }

        for (const [key, equipmentSlot] of Object.entries(EQUIPMENT_SLOT_KEYS)) {
            try {
                const slot = equippable.getEquipmentSlot(equipmentSlot);
                snapshot[key] = slot && slot.hasItem() ? snapshotItemStack(slot.getItem()) : undefined;
            } catch (e) {
                snapshot[key] = undefined;
            }
        }

        const nonEmpty = Object.entries(snapshot).filter(([, v]) => v).map(([k, v]) => `${k}=${v.typeId}`);
        if (nonEmpty.length > 0) {
            rdLog(`buildMobEquipmentSnapshot: mob typeId="${mob.typeId}" id=${mob.id} recorded this tick: ${nonEmpty.join(", ")}`);
        }
    } catch (e) {
        // fail soft - snapshot stays whatever slots were read before the failure
    }
    return snapshot;
}


function buildMobStatusSnapshot(mob) {
    let onFire = false;
    let isTamed = false;
    try { onFire = !!mob.getComponent("minecraft:onfire"); } catch (e) {}
    try {
        const tameable = mob.getComponent("minecraft:tameable");
        isTamed = !!(tameable && tameable.isTamed);
    } catch (e) {}
    return { onFire, isTamed };
}

function mobStatusesMatch(a, b) {
    return !!a && !!b && a.onFire === b.onFire && a.isTamed === b.isTamed;
}

function buildState(player) {
    const loc = player.location;
    const rot = player.getRotation();
    const vel = player.getVelocity();

    const health = getHealth(player);
    const heldItemTypeId = getHeldItemTypeId(player);
    const usingItem = !!usingItemState.get(player.id);

    let level;
    let totalXp;
    try {
        level = player.level;
        totalXp = player.getTotalXp ? player.getTotalXp() : undefined;
    } catch (e) {
        level = undefined;
        totalXp = undefined;
    }

    let onGround;
    let climbing;
    let falling;
    let gliding;
    try {
        onGround = player.isOnGround;
        climbing = player.isClimbing;
        falling = player.isFalling;
        gliding = player.isGliding;
    } catch (e) {
        onGround = undefined;
        climbing = undefined;
        falling = undefined;
        gliding = undefined;
    }

    return {
        dimensionId: player.dimension.id,
        x: round(loc.x, 2),
        y: round(loc.y, 2),
        z: round(loc.z, 2),
        yaw: round(rot.y, 1),
        pitch: round(rot.x, 1),
        vx: round(vel.x, 2),
        vy: round(vel.y, 2),
        vz: round(vel.z, 2),
        sprinting: player.isSprinting,
        sneaking: player.isSneaking,
        swimming: player.isSwimming,
        flying: player.isFlying,
        gliding,
        jumping: player.isJumping,
        onGround,
        climbing,
        falling,
        heldItemTypeId,
        usingItem,
        health,
        level,
        totalXp,
        selectedSlot: player.selectedSlotIndex
    };
}

function statesMatch(a, b) {
    return (
        a.dimensionId === b.dimensionId &&
        Math.abs(a.x - b.x) < POSITION_EPSILON &&
        Math.abs(a.y - b.y) < POSITION_EPSILON &&
        Math.abs(a.z - b.z) < POSITION_EPSILON &&
        Math.abs(a.yaw - b.yaw) < ROTATION_EPSILON &&
        Math.abs(a.pitch - b.pitch) < ROTATION_EPSILON &&
        Math.abs(a.vx - b.vx) < VELOCITY_EPSILON &&
        Math.abs(a.vy - b.vy) < VELOCITY_EPSILON &&
        Math.abs(a.vz - b.vz) < VELOCITY_EPSILON &&
        a.sprinting === b.sprinting &&
        a.sneaking === b.sneaking &&
        a.swimming === b.swimming &&
        a.flying === b.flying &&
        a.gliding === b.gliding &&
        a.jumping === b.jumping &&
        a.onGround === b.onGround &&
        a.climbing === b.climbing &&
        a.falling === b.falling &&
        a.heldItemTypeId === b.heldItemTypeId &&
        a.usingItem === b.usingItem &&
        a.health === b.health &&
        a.level === b.level &&
        a.totalXp === b.totalXp &&
        a.selectedSlot === b.selectedSlot
    );
}

function round(n, decimals) {
    const factor = 10 ** decimals;
    return Math.round(n * factor) / factor;
}

function summarize() {
    let entryCount = 0;
    let approxBytes = 0;
    for (const entries of recordingState.buffer.values()) {
        entryCount += entries.length;
        approxBytes += JSON.stringify(entries).length;
    }
    for (const entries of recordingState.equipmentBuffer.values()) {
        entryCount += entries.length;
        approxBytes += JSON.stringify(entries).length;
    }
    let mobEntryCount = 0;
    let mobApproxBytes = 0;
    let mobCount = 0;
    let projectileCount = 0;
    for (const [entityId, entries] of recordingState.mobBuffer.entries()) {
        mobEntryCount += entries.length;
        mobApproxBytes += JSON.stringify(entries).length;
        const typeId = recordingState.mobTypeIds.get(entityId);
        if (isReplayProjectileType(typeId)) projectileCount++;
        else mobCount++;
    }
    return {
        frameCount: recordingState.tick,
        playerCount: recordingState.buffer.size,
        entryCount,
        approxBytes: approxBytes + mobApproxBytes,
        // Mob/projectile fields are additive; the transform stream remains
        // shared so existing replay storage stays backward compatible.
        mobCount,
        mobEntryCount,
        projectileCount,
        allocated: recordingState.pendingReplayId
    };
}
