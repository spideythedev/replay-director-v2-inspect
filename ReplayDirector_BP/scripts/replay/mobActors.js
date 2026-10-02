/**
 * Replay Director - Mob Actors (Record & Replay Mobs pass, v1)
 *
 * Thin wrapper around this pack's own mob puppet entities
 * (replay:mob_zombie, replay:mob_skeleton, replay:mob_cow, replay:mob_pig -
 * see mobSupport.js), mirroring actors.js's spawnActor/updateActorTransform/
 * updateActorTransformInterpolated pattern exactly for players.
 *
 * REPLAY MOB ACTOR IMPLEMENTATION:
 * Playback uses the pack's replay mob definitions and drives their recorded
 * transforms and visual state from the captured timeline. The definitions
 * provide deterministic presentation while the playback code controls the
 * recorded path.
 *
 * WHY THIS STILL GETS THE MOB'S REAL LOOK (confirmed, not guessed):
 * a client entity file's geometry/textures/render_controllers/animations
 * fields are just string references - see ReplayDirector_RP/entity/
 * replay_actor.json, which already reuses geometry.humanoid.custom this
 * way. Nothing requires those strings to point at OUR geometry/textures -
 * ReplayDirector_RP/entity/mob_zombie.json (etc.) points its geometry/
 * texture/render_controller fields at the exact same real vanilla
 * shortnames minecraft:zombie's own client entity file uses
 * (geometry.zombie, textures/entity/zombie/zombie, controller.render.
 * zombie), confirmed by inspecting Mojang's own bedrock-samples zombie
 * client entity file. This gets the mob's correct model/texture/render
 * pipeline for free - only the ANIMATION side needs our own wiring (see
 * below), not the model/texture side.
 *
 * WHY ANIMATION STILL NEEDS OUR OWN WIRING (confirmed, not guessed):
 * vanilla's own move/attack animation controllers
 * (controller.animation.humanoid.move, controller.animation.zombie.
 * attack_bare_hand, etc.) depend on movement-state queries that are not
 * naturally produced by a teleport-driven replay actor. Each
 * mob_*.json client entity file therefore references the mob's REAL
 * vanilla animation shortnames directly (e.g. "walk":
 * "animation.zombie.walk" is not real - the confirmed real shortname is
 * captured per-mob in that file's own header comment) but drives them
 * through OUR OWN animation controllers keyed on OUR OWN script-set
 * entity properties (replay:mob_moving, replay:mob_attacking), the same
 * pattern replay_actor.animation_controllers.json already uses - not
 * through vanilla's physics-derived controllers.
 */

import { system, world } from "@minecraft/server";
import { rdLog, rdWarn, rdError } from "../core/debugLog.js";
import { applyActorEquipment, equipmentMapsEqual } from "./equipment.js";
import { reserveReplayMobSpawn } from "./spawnIsolation.js";

const MOVING_SPEED_THRESHOLD = 0.02; // blocks/tick - matches actors.js's own threshold for players

/**
 * Offset added to a mob's spawn-order index before it's used as an ashN
 * tag suffix - keeps mob tags (ash100001, ash100002, ...) numerically far
 * away from any realistic player actor tag (ash1, ash2, ...), so the two
 * populations' tags can never collide on the same live entity set while
 * both still match equipment.js's shared `/^ash\d+$/` lookup regex
 * unmodified (that file is player-tested working infrastructure and is
 * deliberately not touched by this pass).
 */
const MOB_ASH_TAG_OFFSET = 100000;

/**
 * Targeted vanilla companion suppression.
 *
 * We do NOT sweep arbitrary nearby mobs after a replay spawn. That older
 * radius-diff approach could delete legitimate entities that happened to
 * spawn in the same few ticks. The only confirmed vanilla side-effect
 * relevant to this replay system is Wandering Trader -> Trader Llama.
 *
 * Mojang's current entity-spawn API exposes the initialization cause; trader
 * llamas created by the trader use an Event initialization cause. We therefore
 * suppress only trader llamas created as an Event while a replay-spawned
 * wandering trader is in the tiny pending window. Independently replayed
 * llamas are spawned with the normal Spawned cause and are never touched.
 */
const pendingTraderCompanionSpawns = [];

function distanceSquared(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const dz = a.z - b.z;
    return dx * dx + dy * dy + dz * dz;
}

function trackPendingTrader(location) {
    const token = {
        location: { x: location.x, y: location.y, z: location.z },
    };
    pendingTraderCompanionSpawns.push(token);
    system.runTimeout(() => {
        const index = pendingTraderCompanionSpawns.indexOf(token);
        if (index >= 0) pendingTraderCompanionSpawns.splice(index, 1);
    }, 3);
}

/**
 * Only removes the vanilla trader companion that the replay-spawned trader
 * itself creates. This listener is deliberately narrow and never performs a
 * generic "new nearby mob" deletion.
 */
try {
    world.afterEvents.entitySpawn.subscribe((spawnEvent) => {
        const entity = spawnEvent?.entity;
        if (!entity || entity.typeId !== "minecraft:trader_llama") return;
        if (spawnEvent.cause !== "Event") return;

        for (let i = pendingTraderCompanionSpawns.length - 1; i >= 0; i--) {
            const pending = pendingTraderCompanionSpawns[i];
            if (distanceSquared(entity.location, pending.location) <= 36) {
                try { entity.remove(); } catch (e) {}
                return;
            }
        }
    });
} catch (e) {
    // If the optional spawn signal is unavailable in the target runtime,
    // replay spawning itself remains functional; no broad suppression is used.
}

/**
 * Spawn a real vanilla mob for playback. There is intentionally no
 * per-type permanent failure cache: a failed spawn is transient and the
 * playback lifecycle already supplies a 20-tick retry/backoff window.
 *
 * @param {import("@minecraft/server").Dimension} dimension
 * @param {string} spawnType
 * @param {{x:number,y:number,z:number}} location
 * @returns {import("@minecraft/server").Entity|undefined}
 */
function spawnGenericMob(dimension, spawnType, location) {
    // Replay Spawn Isolation: reserve the exact replay-created mob before
    // calling spawnEntity(). The isolation listener then allows this entity
    // through while suppressing unrelated natural mob initialization inside
    // the restored scene.
    reserveReplayMobSpawn(spawnType, dimension.id, location);

    if (spawnType === "minecraft:wandering_trader") {
        trackPendingTrader(location);
    }
    return dimension.spawnEntity(spawnType, location);
}

/**
 * @param {import("@minecraft/server").Dimension} dimension
 * @param {{x:number,y:number,z:number}} location
 * @param {object} mobRecord - one entry from a saved replay's `mobs` array (see storage.js's saveReplayFromRecording)
 * @param {number} [ashTagIndex] - 1-based index for this mob within the current playback session, used to tag the entity "ash100001", "ash100002", ... - MUST match equipment.js's own `/^ash\d+$/` tag-lookup regex exactly (a "ashmob1"-style prefix would silently NOT match that regex and equipment would never apply - confirmed by re-reading equipment.js's own pattern rather than assumed), so this reuses the exact "ash" + digits shape player actors use (see actors.js's spawnActor), just offset by a large constant (MOB_ASH_TAG_OFFSET) so a mob's tag can never numerically collide with any realistic player actor count on the same live entity set.
 * @returns {import("@minecraft/server").Entity|undefined}
 */
export function spawnMobActor(dimension, location, mobRecord, ashTagIndex) {
    // All normal mobs are now replayed as their REAL vanilla entity type.
    // There is no dedicated zombie/skeleton/pig/cow puppet path anymore.
    const spawnType = mobRecord.typeId;

    let entity;
    try {
        entity = spawnGenericMob(dimension, spawnType, location);
    } catch (e) {
        rdError(`spawnMobActor: dimension.spawnEntity("${spawnType}") THREW - mob actor was not spawned.`, e);
        return undefined;
    }

    if (!entity) {
        rdError(`spawnMobActor: dimension.spawnEntity("${spawnType}") returned no entity.`);
        return undefined;
    }

    // Best-effort baby reproduction using the real read-only vanilla state.
    // We never invent a writable "is baby" property.
    if (mobRecord.isBaby) {
        const MAX_BABY_REROLL_ATTEMPTS = 8;
        let isActuallyBaby = false;
        try { isActuallyBaby = !!entity.getComponent("minecraft:is_baby"); } catch (e) {}
        let attempts = 0;
        while (!isActuallyBaby && attempts < MAX_BABY_REROLL_ATTEMPTS) {
            attempts++;
            try { entity.remove(); } catch (e) {}
            let rerolled;
            try {
                rerolled = spawnGenericMob(dimension, spawnType, location);
            } catch (e) {
                rerolled = undefined;
            }
            if (!rerolled) break;
            entity = rerolled;
            try { isActuallyBaby = !!entity.getComponent("minecraft:is_baby"); } catch (e) {}
        }
    }

    try { entity.addTag("replay_generic_mob"); } catch (e) {}

    // Do NOT add artificial Resistance or Fire Resistance. Those changed the
    // recorded scene. Playback owns the transform/health timeline instead.
    try { entity.clearVelocity(); } catch (e) {}

    if (ashTagIndex) {
        const tag = `ash${MOB_ASH_TAG_OFFSET + ashTagIndex}`;
        try { entity.addTag(tag); } catch (e) {}
    }

    if (mobRecord.visible === false) {
        try { entity.setProperty("replay:mob_hidden", true); } catch (e) {}
    }

    return entity;
}

/**
 * Applies a full equipment snapshot ({head, chest, legs, feet, mainhand,
 * offhand}) to a live mob puppet - mirrors actors.js's updateActorEquipment
 * exactly (same skip-if-unchanged-since-last-apply optimization via
 * equipmentMapsEqual, so this doesn't re-run six /replaceitem commands
 * every single tick for the overwhelming majority of ticks where a mob's
 * equipment hasn't actually changed - the same cost-avoidance the player
 * path already relies on), built on equipment.js's applyActorEquipment()
 * (already fully generic, tag-based /replaceitem, no player-specific code
 * inside it - needs no changes of its own to support mobs).
 * @param {import("@minecraft/server").Entity} entity
 * @param {object|undefined} equipment
 * @param {object|undefined} previousEquipment - the map last actually applied to this entity, so unchanged slots are skipped
 * @returns {object|undefined} the equipment map now considered "applied" (echoed back, or previousEquipment if nothing changed/nothing to apply)
 */
export function updateMobActorEquipment(entity, equipment, previousEquipment) {
    if (!entity || !entity.isValid) return previousEquipment;
    if (!equipment) return previousEquipment;
    if (equipmentMapsEqual(equipment, previousEquipment)) return previousEquipment;

    return applyActorEquipment(entity, equipment);
}

/**
 * @param {import("@minecraft/server").Entity} entity
 * @param {{x:number,y:number,z:number}} location
 * @param {{yaw:number,pitch:number}} rotation
 */
function stabilizeGenericVanillaMob(entity) {
    if (!entity || !entity.isValid) return;
    try {
        if (entity.hasTag("replay_generic_mob")) entity.clearVelocity();
    } catch (e) {}
}

export function updateMobActorTransform(entity, location, rotation) {
    if (!entity || !entity.isValid) return;
    try {
        // keepVelocity: false (Motion Fidelity pass, found via a direct
        // code comparison against another reference pack) - confirmed
        // real TeleportOptions field (Bedrock 1.20.0 changelog). Without
        // it, a GENERIC mob's own live velocity from the
        // moment just before this teleport carries over and keeps
        // influencing it afterward - the teleport moves the entity to
        // the right spot, but its own residual momentum/facing-intent
        // can still fight that on the next physics step, which is a
        // very plausible explanation for reports like "the pillager
        // shoots from the front instead of the back it actually
        // attacked from" - its own movement state was still partially acting on
        // stale velocity/target state between our per-tick snaps,
        // rather than being fully reset by each position update the way
        // a puppet with zero physics of its own already is by default.
        entity.teleport(location, { rotation: { x: rotation.pitch, y: rotation.yaw }, keepVelocity: false });
        stabilizeGenericVanillaMob(entity);

        // Best-effort flying-animation nudge (Parrot Flight pass, v2 -
        // height-based per the user's own suggested heuristic). Honest
        // confidence level: MEDIUM, not confirmed working (no way to
        // test live from here). A real reported bug: a replayed parrot
        // correctly follows its recorded flight PATH (position is fine)
        // but looks like it's motionlessly floating rather than flapping
        // - vanilla parrot.json's own animation state Molang
        // (query.is_on_ground ? standing/perched : flying) is a REAL
        // PHYSICS query, not something a repeated teleport necessarily
        // keeps in the "actively airborne" state the way genuine
        // ordinary flight movement would.
        //
        // Tracks a per-entity "last grounded" Y reference: while the mob
        // stays within 1.5 blocks of that reference (matches the user's
        // own suggested threshold), it's treated as grounded/perched and
        // the reference just follows it down, no nudge applied - once it
        // climbs more than 1.5 blocks above that reference (a real
        // recorded takeoff), the nudge kicks in to keep the physics
        // engine's own ground-contact tracking in the "not settled" state
        // real flight would produce.
        //
        // Moved here from the now-removed updateMobActorTransformInterpolated
        // (Movement Reliability pass retired mob position interpolation
        // entirely in favor of direct per-tick snapping - see
        // playback.js's renderMobsAtPlayhead) - this is the function that
        // actually runs every tick now, so the nudge has to live here to
        // keep working at all.
        if (FLYING_MOB_TYPE_IDS.has(entity.typeId)) {
            try {
                const groundRef = flyingMobGroundY.has(entity.id) ? flyingMobGroundY.get(entity.id) : location.y;
                const heightAboveGround = location.y - groundRef;
                if (heightAboveGround > 1.5) {
                    entity.applyImpulse({ x: 0, y: 0.02, z: 0 });
                    // Deliberately does NOT update the reference while
                    // airborne - it should keep comparing against where
                    // the bird actually last touched down, not silently
                    // creep upward with it.
                } else {
                    flyingMobGroundY.set(entity.id, location.y);
                }
            } catch (e) {
                // fail soft - purely a best-effort animation nudge, not required for correct position replay
            }
        }
    } catch (e) {
        // Surfaced (debug-toggle-gated, not spammy) rather than silently
        // swallowed - a teleport that keeps throwing every tick for the
        // same mob is exactly the kind of thing that LOOKS like a random
        // freeze from in-game, so this needs to be visible under
        // /scriptevent replay:debug on instead of hidden, same lesson as
        // the v1.6.6 equipment investigation.
        rdLog(`updateMobActorTransform: entity.teleport() threw for mob puppet id=${entity.id} typeId=${entity.typeId} - frame skipped.`, e);
    }
}

/** @type {Set<string>} known flying-type species (Parrot Flight pass, best-effort) - see updateMobActorTransform's own comment for why this exists and its honest confidence level. */
const FLYING_MOB_TYPE_IDS = new Set([
    "minecraft:parrot",
    "minecraft:bat",
    "minecraft:bee",
    "minecraft:phantom",
    "minecraft:ghast",
    "minecraft:vex",
    "minecraft:allay"
]);

/** @type {Map<string, number>} entity.id -> a tracked "last grounded" Y reference for known flying species (Parrot Flight pass v2) - see updateMobActorTransform's own comment for the height-based heuristic this drives. */
const flyingMobGroundY = new Map();

/**
 * Retained for now but no longer called anywhere (Movement Reliability
 * pass retired mob position interpolation - see playback.js's
 * renderMobsAtPlayhead for the full reasoning). Left in place rather than
 * deleted in case sub-tick blending is deliberately reintroduced later
 * for a specific use case (e.g. an opt-in "cinematic smoothing" mode) -
 * it's simply dead code until then, not broken code.
 * @param {import("@minecraft/server").Entity} entity
 * @param {{x:number,y:number,z:number,yaw:number,pitch:number}} fromState
 * @param {{x:number,y:number,z:number,yaw:number,pitch:number}} toState
 * @param {number} t
 */
export function updateMobActorTransformInterpolated(entity, fromState, toState, t) {
    if (!entity || !entity.isValid) return;
    try {
        const clampedT = Math.max(0, Math.min(1, t));
        const x = lerp(fromState.x, toState.x, clampedT);
        const y = lerp(fromState.y, toState.y, clampedT);
        const z = lerp(fromState.z, toState.z, clampedT);
        const yaw = lerpAngle(fromState.yaw, toState.yaw, clampedT);
        const pitch = lerp(fromState.pitch, toState.pitch, clampedT);

        entity.teleport({ x, y, z }, { rotation: { x: pitch, y: yaw }, keepVelocity: false });
        stabilizeGenericVanillaMob(entity);
    } catch (e) {
        // Same reasoning as updateMobActorTransform above - a mob that
        // silently stops accepting teleports (rather than genuinely having
        // no more recorded movement) is indistinguishable from a real
        // freeze without this being visible somewhere.
        rdLog(`updateMobActorTransformInterpolated: entity.teleport() threw for mob puppet id=${entity.id} typeId=${entity.typeId} - frame skipped.`, e);
    }
}

/**
 * Sets the movement-state property mob_*.json's own animation controller
 * reads (see that file's own header). v1 only tracks moving/not-moving,
 * derived from recorded position delta between two frames (mobs don't
 * have a recorded velocity field the way players do - see capture.js's
 * buildMobState - so "moving" is inferred from ground distance travelled
 * between the previous applied frame and this one, not a directly
 * recorded velocity).
 * @param {import("@minecraft/server").Entity} entity
 * @param {boolean} moving
 */
export function updateMobActorAnimationState(entity, moving) {
    if (!entity || !entity.isValid) return;
    // Generic vanilla entities use their native animation controllers. The
    // old replay:mob_moving property belonged to retired custom puppets and
    // must never be written to real vanilla entities.
}

/** @returns {boolean} whether ground distance between two recorded mob states exceeds the moving threshold */
export function mobGroundSpeedExceeds(fromState, toState) {
    const dx = toState.x - fromState.x;
    const dz = toState.z - fromState.z;
    return Math.hypot(dx, dz) > MOVING_SPEED_THRESHOLD;
}

/**
 * @param {import("@minecraft/server").Entity} entity
 */
export function removeMobActor(entity) {
    if (!entity || !entity.isValid) return;
    try {
        flyingMobGroundY.delete(entity.id);
    } catch (e) {
        // fail soft
    }
    try {
        entity.remove();
    } catch (e) {
        // fail soft
    }
}

/**
 * Death effect (Mob Death Effect pass) - called by syncMobLifecycle
 * specifically at the moment a mob crosses its recorded despawnTick (a
 * real death), as opposed to removeMobActor above, which stays a silent,
 * no-effect removal for session cleanup (playback stopped) where a death
 * animation would be wrong - the video simply ended, nothing "died".
 *
 * Two real, different, confirmed mechanisms depending on puppet-vs-generic:
 *
 * - Generic (real vanilla) mobs: `entity.kill()` triggers the ENGINE'S OWN
 *   hardcoded death sequence - confirmed (Bedrock Wiki, "Non-Mob Runtime
 *   Identifiers"): the Replay Director death pulse particle, a 90°
 *   rotation flop over the first 0.5 seconds, the entity's real death
 *   sound, then a 1-second despawn delay. This is the exact "signature
 *   faint down effect" real Minecraft always shows - no custom scripting
 *   needed, it's the same code path a real death from real damage uses.
 *
 * - Puppet mobs (zombie/skeleton/pig) are damage-immune by design
 *   (minecraft:damage_sensor blocks all real damage - see this file's own
 *   header), so they can never "take fatal damage" for the engine's own
 *   hardcoded sequence above to trigger at all. This manually replicates
 *   the same documented sequence instead: spawns the same real
 *   Replay Director death pulse particle, plays a best-effort death
 *   sound (wrapped safely - a wrong/legacy sound id just stays silent,
 *   never breaks anything), animates the same 90°-over-10-ticks rotation
 *   flop via direct teleports, then removes the entity after the same
 *   ~1-second delay - a deliberate, documented-behavior-matching
 *   replication rather than an invented effect.
 * @param {import("@minecraft/server").Entity} entity
 * @param {import("@minecraft/server").System} system
 */
/**
 * @param {import("@minecraft/server").Entity} entity
 * @param {import("@minecraft/server").System} system
 * @param {() => boolean} [isPausedFn] - called every tick during the
 * puppet's post-death particle/sound window (see below) to decide
 * whether the final removal should hold off. Defaults to "never paused"
 * if not provided, so existing callers that don't pass it keep working
 * exactly as before. playback.js passes its own isPaused() export here -
 * mobActors.js deliberately does NOT import playback.js directly to
 * avoid a circular import (playback.js already imports FROM this file),
 * so the check is injected as a plain callback instead.
 */
export function killMobActor(entity, system, isPausedFn) {
    if (!entity || !entity.isValid) return;

    // Prefer a real lethal damage path for generic vanilla entities. This
    // lets the engine own the mob's normal death transition/animation/loot
    // path instead of immediately removing the entity. If a particular
    // entity rejects scripted damage, fall back to Entity.kill().
    try {
        const health = entity.getComponent("minecraft:health");
        const current = health ? Number(health.currentValue) : NaN;
        if (Number.isFinite(current) && current > 0) {
            const applied = entity.applyDamage(current + 1, { cause: "override" });
            if (applied) return;
        }
    } catch (e) {
        // Fall through to the documented kill() path.
    }

    try {
        entity.kill();
    } catch (e) {
        try { entity.remove(); } catch (e2) {}
    }
}

/**
 * Mob Attack Animation pass: brief attack-swing pulse for a mob puppet,
 * fired by eventPlayback.js when the recording's entity_damage event
 * replays and the recorded attacker was one of our own tracked mobs (see
 * events.js's attackerMobId field) - same auto-clearing pulse mechanism
 * as actors.js's triggerAttackPulse/triggerUsePulse (set a bool property,
 * clear it again after durationTicks via system.runTimeout), just using
 * this puppet's own replay:mob_attacking property instead of the player
 * actor's replay:use_pulse/swing_type pair. Kept a single generic swing
 * (no per-weapon variant selection like the player path's classifySwingType)
 * since v1's supported mobs (zombie, skeleton) each only ever swing bare-
 * handed or with their single natural weapon - there's no held-item swap
 * to distinguish between, unlike a player who can equip any tool.
 * @param {import("@minecraft/server").Entity} entity
 * @param {import("@minecraft/server").System} system
 * @param {number} [durationTicks=6] - matches the biped swing animation's own ~0.3s length (6 ticks) so the property clears right as the animation finishes, not mid-swing
 */
export function triggerMobAttackPulse(entity, system, durationTicks = 6) {
    // Generic vanilla entities own their attack animation. The stable 2.2.0
    // Script API does not expose a universal "swing arm" setter for every mob,
    // so never set a custom replay property on a vanilla entity.
    if (!entity || !entity.isValid) return;
}

/**
 * Victim hurt-reaction (Mob Hurt Reaction pass) - fired by eventPlayback.js
 * when the recording's entity_damage/player_damage event replays and the
 * VICTIM was one of our own tracked mobs (looked up via
 * state.mobEntities.get(event.data.entityId) - the original recording's
 * own entity id, which is exactly what mobId already is throughout this
 * codebase). Two completely different real mechanisms depending on
 * puppet-vs-generic, because they have fundamentally different damage
 * capabilities:
 *
 * - Puppet mobs (zombie/skeleton/pig) are damage-immune by design
 *   (minecraft:damage_sensor blocks all damage - see this file's own
 *   header for why), so `entity.applyDamage()` would silently do nothing
 *   on them. Uses the exact same auto-clearing custom-property + resource
 *   -pack overlay_color technique already proven working for the player
 *   actor's own replay:hurt_pulse (see actors.js's triggerHurtPulse and
 *   replay_actor's render controller) - replicated per-puppet as
 *   replay:mob_hurt_pulse, wired to each puppet's OWN new render
 *   controller (controller.render.replay_mob_<type>) rather than
 *   overwriting vanilla's shared controller.render.<type> identifier,
 *   which would have affected every real <type> mob in the world, not
 *   just this puppet.
 *
 * - Generic (non-puppet) mobs ARE real vanilla entities with real health,
 *   so `entity.applyDamage(1)` triggers the engine's own NATIVE hurt
 *   flash, knockback, and hurt sound - no custom property or resource
 *   pack work needed at all, and it's guaranteed visually correct since
 *   it's the same code path the entity's real vanilla hurt reaction
 *   always uses. Health is captured beforehand and restored a moment
 *   later (EntityHealthComponent.setCurrentValue - a real, confirmed
 *   settable API, distinct from EntityScaleComponent.value which is
 *   read-only and was the root cause of an earlier, separate bug) so a
 *   scripted recreation of a non-fatal recorded hit can never actually
 *   kill the mob out of sync with the recording - actual death is still
 *   owned exclusively by syncMobLifecycle's despawnTick removal.
 * @param {import("@minecraft/server").Entity} entity
 * @param {import("@minecraft/server").System} system
 */
export function triggerMobHurtReaction(entity, system) {
    if (!entity || !entity.isValid) return;

    const isGeneric = entity.hasTag("replay_generic_mob");

    if (!isGeneric) {
        try {
            entity.setProperty("replay:mob_hurt_pulse", true);
            system.runTimeout(() => {
                try {
                    if (entity && entity.isValid) entity.setProperty("replay:mob_hurt_pulse", false);
                } catch (e) {
                    // fail soft
                }
            }, 5);
        } catch (e) {
            // fail soft - cow/pig only got this property added alongside
            // zombie/skeleton in the same pass, so this should never
            // actually miss on any of the 4 puppet types, but fails soft
            // regardless in case a future puppet type is added without it
        }
        return;
    }

    try {
        const health = entity.getComponent("minecraft:health");
        const previousValue = health ? Number(health.currentValue) : NaN;
        // Never use a full 1 damage pulse on a mob that has <=1 HP left:
        // that could accidentally kill a replay actor whose actual recorded
        // death is scheduled separately by the lifecycle timeline.
        if (!health || !Number.isFinite(previousValue) || previousValue <= 1) return;
        const applied = entity.applyDamage(Math.min(1, previousValue - 0.01));
        if (applied) {
            try { health.setCurrentValue(previousValue); } catch (e) {}
        }
    } catch (e) {
        // fail soft - a missing health component or a throwing
        // applyDamage call (e.g. an entity type that can't take damage
        // for some other vanilla reason) just means no scripted reaction
        // plays for this one hit, nothing else is affected
    }
}

function lerp(a, b, t) {
    return a + (b - a) * t;
}

function lerpAngle(a, b, t) {
    let diff = ((b - a + 180) % 360 + 360) % 360 - 180;
    return a + diff * t;
}
