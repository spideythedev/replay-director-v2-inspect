/**
 * Replay Director - World Event Playback (Phase 3F core, item_use/mining/
 * block-place swing pulses added in the Replay Actor Animation System pass,
 * block_interact pulse added in the World Interaction Replay pass)
 *
 * A deliberate safety line runs through this file: playback is supposed to
 * be a passive viewing experience with respect to anything NOT already
 * captured from the original recording, so nothing here mutates world
 * state beyond what worldReplay.js already reproduces from real recorded
 * data, and nothing here acts on real, pre-existing world entities.
 * Concretely:
 *
 * - mob_spawn: legacy generic spawn events are ignored. The corrected replay
 *   system never generically spawns vanilla entities because only the
 *   supported replay-mob puppets have intentional playback implementations.
 * - mob_death: removes the controlled replay-mob puppet corresponding to the
 *   recorded supported mob id. It never spawns or mutates a real vanilla mob.
 * - explosion: particle-only recreation (no real block damage) - the real
 *   block damage from an explosion is a separate captured event
 *   (block_explode) handled entirely by worldReplay.js, not here.
 * - item_use: triggers a brief generic "use" pulse on the matching replay
 *   actor (the actual bow/crossbow/trident/shield pose distinction is
 *   driven separately, per-tick, from the recorded heldItemTypeId/usingItem
 *   fields in actors.js's updateActorAnimationState - this pulse is just
 *   the accompanying arm-swing moment).
 * - block_place / block_break / block_interact: trigger a brief arm-swing
 *   pulse on the matching replay actor. The actual block mutation (placing/
 *   breaking/restoring/changing state) is handled entirely by
 *   worldReplay.js from the same recorded event list, reading the exact
 *   before/after permutation snapshots events.js captured - this file only
 *   adds the visual "an actor did something here" cue on top of that, it
 *   never mutates a block itself.
 * - block_explode: no actor-facing pulse (an explosion isn't necessarily
 *   attributable to a specific recorded player) - the block mutation is
 *   handled by worldReplay.js exactly like the other three block_* types.
 * - player_death / entity_damage / player_damage: player_death marks the
 *   matching actor dead (see actors.js); the damage events trigger a hurt
 *   flash on the victim's actor and an attack swing on the attacker's
 *   actor when one was recorded. None of this acts on real, foreign
 *   entities - only on replay actors this playback itself owns.
 */

import { system } from "@minecraft/server";
import { getEventData } from "./storage.js";
import { rdLog } from "../core/debugLog.js";
import {
    triggerUsePulse,
    triggerHurtPulse,
    triggerAttackPulse,
    triggerMiningPulse,
    triggerPlacePulse,
    markActorDead,
    reviveActor
} from "./actors.js";
import {
    triggerMobAttackPulse,
    spawnMobActor,
    removeMobActor,
    triggerMobHurtReaction
} from "./mobActors.js";

/**
 * Animation Improvements pass (mining anticipation): how far ahead of a
 * recorded block_break event to start the actor's hand-shake swing, in
 * ticks - 20 ticks = 1 real-time second at 1x speed. This is a fixed
 * visual anticipation window, not itself something that was recorded (the
 * codebase has no per-block mining-progress capture - see the file
 * header's own honesty note on what's real vs approximated), so it's
 * applied the same way regardless of what tool/block was actually
 * involved, same as the existing block_break swing pulse already treats
 * every break identically.
 */
const MINING_ANTICIPATION_TICKS = 20;

const state = {
    active: false,
    events: [],
    /** Index of the last event that has been applied (forward). -1 means none applied yet - same convention worldReplay.js uses, so seeking is a single consistent pattern across both event stores. */
    cursor: -1,
    dimension: undefined,
    director: undefined,
    /** @type {Map<string, import("@minecraft/server").Entity>} playerId -> the actor entity representing them this playback (passed in from playback.js, not owned here) */
    actorEntities: new Map(),
    /** @type {Set<string>} playerId of any actor whose recorded player_death event has fired this playback - playback.js checks this to stop overriding the death pose's rotation every tick */
    deadActorPlayerIds: new Set(),
    /**
     * Animation Improvements pass (mining anticipation): indices into
     * state.events for block_break events whose PRE-BREAK anticipation
     * swing has already started this playback - a Set, not a boolean flag
     * on the event itself, so a seek backward past a break naturally
     * "forgets" it fired (see seekEventPlayback below) and can correctly
     * fire again if forward playback reaches it a second time. Keyed by
     * event ARRAY INDEX, not by any property on the event object itself -
     * events are plain data read from storage, mutating them to carry
     * playback-session state would leak session state into what's
     * otherwise a pure, replayable data source.
     * @type {Set<number>}
     */
    miningAnticipationFired: new Set(),
    hitEventKeys: new Set()
};

/**
 * @param {string} playerId
 * @returns {boolean} whether this actor's recorded death event has already fired this playback
 */
export function isActorDead(playerId) {
    return state.deadActorPlayerIds.has(playerId);
}

/**
 * @param {string} replayId
 * @param {import("@minecraft/server").Dimension} dimension
 * @param {Map<string, import("@minecraft/server").Entity>} actorEntities - playback.js's own map, passed by reference so item_use can find the right actor
 */
export function beginEventPlayback(replayId, dimension, actorEntities, mobEntities, director) {
    state.active = true;
    state.events = (getEventData(replayId) || [])
        .filter((event) => !event.data?.dimensionId || event.data.dimensionId === dimension.id)
        .slice()
        .sort((a, b) => a.tick - b.tick);
    state.cursor = -1;
    state.dimension = dimension;
    state.director = director;
    state.actorEntities = actorEntities || new Map();
    // Mob attacker lookup (Mob Attack Animation pass) - same shape as
    // actorEntities above, parallel Map, never merged (a mob puppet and a
    // player actor are never looked up through the same Map, same
    // reasoning as every other mob/player split in this codebase).
    state.mobEntities = mobEntities || new Map();
    state.deadActorPlayerIds = new Set();
    state.miningAnticipationFired = new Set();
    state.hitEventKeys = new Set();

    // Always-visible: shows exactly what got recorded for this replay,
    // broken down by type - if attack/mining/placement swings aren't
    // showing on playback, this line alone tells us whether the events
    // were ever captured at all (0 of that type = a capture-side/events.js
    // problem, not a playback/animation problem).
    const typeCounts = {};
    for (const e of state.events) {
        typeCounts[e.type] = (typeCounts[e.type] || 0) + 1;
    }
    rdLog(`beginEventPlayback: replay ${replayId} loaded ${state.events.length} events - breakdown: ${JSON.stringify(typeCounts)}`);
}

/**
 * Fires every not-yet-applied event scheduled at or before currentTick.
 * Called from playback.js's existing tick loop as a single added line -
 * this only ever moves forward, matching normal forward playback.
 * @param {number} currentTick
 */
export function tickEventPlayback(currentTick) {
    if (!state.active) return;

    // Animation Improvements pass (mining anticipation): scan a SHORT
    // window ahead of the normal forward cursor for any upcoming
    // block_break event within MINING_ANTICIPATION_TICKS, and start that
    // actor's hand-shake swing early - well before fireEvent() actually
    // applies the break itself (the swing pulse duration below is sized
    // to run right up until the real break event fires its own short
    // pulse, so the two hand off seamlessly rather than the hand
    // stopping and restarting). Deliberately a SEPARATE small scan from
    // the main cursor loop below (not folded into it) - the main cursor
    // only ever advances to events at-or-before currentTick and marks
    // them permanently applied, which is exactly wrong for something
    // that needs to trigger BEFORE its own tick arrives while the event
    // itself must still fire normally, in full, when its real tick
    // comes. This scan never advances state.cursor and never calls
    // fireEvent - it only starts an animation early via the SAME
    // triggerMiningPulse used at the real break, just with a longer
    // duration.
    for (let i = state.cursor + 1; i < state.events.length; i++) {
        const event = state.events[i];
        if (event.tick > currentTick + MINING_ANTICIPATION_TICKS) break; // events are tick-sorted, nothing further ahead qualifies yet
        if (event.type !== "block_break") continue;
        if (state.miningAnticipationFired.has(i)) continue;

        const ticksUntilBreak = event.tick - currentTick;
        if (ticksUntilBreak > MINING_ANTICIPATION_TICKS || ticksUntilBreak < 0) continue;

        const actor = event.data.playerId ? state.actorEntities.get(event.data.playerId) : undefined;
        if (actor) {
            // Duration covers from right now through to the real break
            // tick (plus the break event's own short follow-up pulse
            // duration), so the swing animation runs continuously the
            // whole anticipation window instead of ending early and
            // leaving a gap before the real break's own pulse picks up.
            triggerMiningPulse(actor, system, ticksUntilBreak + 3, event.data.toolTypeId);
        }
        state.miningAnticipationFired.add(i);
    }

    while (state.cursor + 1 < state.events.length && state.events[state.cursor + 1].tick <= currentTick) {
        fireEvent(state.events[state.cursor + 1]);
        state.cursor++;
    }
}

/**
 * Re-syncs event playback to an arbitrary target tick (forward OR
 * backward), used by playback.js's seekTo (which covers Restart, Seek/Skip,
 * and Timeline scrubbing - all three route through the same function).
 * Without this, a backward jump left already-fired one-shot events (a mob
 * that spawned, an actor marked dead) applied forever, and a later forward
 * replay of that same span silently skipped re-firing them since the
 * cursor had already passed them - both are Replay Playback Accuracy bugs
 * fixed here by giving this file the same bidirectional cursor worldReplay.js
 * already uses for blocks.
 * @param {number} targetTick
 */
export function seekEventPlayback(targetTick) {
    if (!state.active) return;

    const targetCursor = lastIndexAtOrBefore(state.events, targetTick);

    if (targetCursor > state.cursor) {
        for (let i = state.cursor + 1; i <= targetCursor; i++) {
            fireEvent(state.events[i]);
        }
        state.cursor = targetCursor;
    } else if (targetCursor < state.cursor) {
        for (let i = state.cursor; i > targetCursor; i--) {
            unfireEvent(state.events[i]);
        }
        state.cursor = targetCursor;
    }

    // Animation Improvements pass (mining anticipation): a seek (either
    // direction) can move the playhead to before an upcoming break's
    // anticipation window even if that break's flag was already set (a
    // forward seek could jump straight past a break without the lookahead
    // scan ever running for it, and a backward seek naturally needs to
    // forget anything ahead of the new position so it can fire again on
    // a later re-approach). Clearing every fired flag at/after the new
    // cursor position is simple and correct either way - the lookahead
    // scan in tickEventPlayback will just re-evaluate and re-fire
    // whatever's actually still upcoming from here.
    for (const firedIndex of [...state.miningAnticipationFired]) {
        if (firedIndex > state.cursor) {
            state.miningAnticipationFired.delete(firedIndex);
        }
    }
}

/** @returns {number} index of the last event whose tick <= targetTick, or -1 if none */
function lastIndexAtOrBefore(events, targetTick) {
    let lo = 0;
    let hi = events.length - 1;
    let result = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (events[mid].tick <= targetTick) {
            result = mid;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    return result;
}

export function endEventPlayback() {
    state.active = false;
    state.events = [];
    state.cursor = -1;
    state.dimension = undefined;
    state.actorEntities = new Map();
    state.mobEntities = new Map();
    state.deadActorPlayerIds = new Set();
}

function entityHitKey(event) {
    return `${event.tick}|${event.data?.attackerPlayerId || event.data?.attackerMobId || ""}|${event.data?.victimPlayerId || event.data?.victimMobId || ""}`;
}

function fireRecordedEntityHit(event) {
    const key = entityHitKey(event);
    if (state.hitEventKeys.has(key)) return;
    state.hitEventKeys.add(key);

    const attackerActor = event.data?.attackerPlayerId
        ? state.actorEntities.get(event.data.attackerPlayerId)
        : undefined;
    const attackerMob = event.data?.attackerMobId
        ? state.mobEntities.get(event.data.attackerMobId)
        : undefined;
    const victimActor = event.data?.victimPlayerId
        ? state.actorEntities.get(event.data.victimPlayerId)
        : undefined;
    const victimMob = event.data?.victimMobId
        ? state.mobEntities.get(event.data.victimMobId)
        : undefined;

    try {
        if (attackerActor && attackerActor.isValid) {
            triggerAttackPulse(attackerActor, system, undefined, event.data?.attackerWeaponTypeId);
        } else if (attackerMob && attackerMob.isValid) {
            triggerMobAttackPulse(attackerMob, system);
        }
    } catch (e) {}

    try {
        if (victimActor && victimActor.isValid) {
            triggerHurtPulse(victimActor, system);
        } else if (victimMob && victimMob.isValid) {
            triggerMobHurtReaction(victimMob, system);
        }
    } catch (e) {}

    // entity_hit is deliberately a visual/interaction event. Actual health
    // changes remain owned by the recorded damage/health timeline so a hit
    // that dealt zero damage can still be shown without changing the replayed
    // mob's health.
}

function fireRecordedMobInteraction(event) {
    const actor = event.data?.playerId
        ? state.actorEntities.get(event.data.playerId)
        : undefined;
    if (!actor || !actor.isValid) return;

    // Bedrock does not expose a generic "invoke this mob's interact
    // component" method. Recreate the visible player-side interaction at the
    // exact recorded tick; state-changing interaction results (taming,
    // breeding, item use, etc.) are handled by their own recorded events.
    try {
        triggerUsePulse(actor, system, 3, "hand");
    } catch (e) {}
}

function fireEvent(event) {
    if (!state.dimension) return;

    try {
        switch (event.type) {
            case "mob_spawn":
                // Legacy event records may contain generic mob_spawn entries.
                // Never replay them: arbitrary vanilla entity spawning has no
                // intentional puppet implementation and can recreate live behavior or
                // duplicate controlled replay mobs.
                break;
            case "mob_death": {
                // Mob lifecycle is authoritative for death/despawn. The
                // entityDie event remains in the recording for diagnostics,
                // but spawning an actor from it here would race
                // syncMobLifecycle and could duplicate a dead mob.
                break;
            }
            case "entity_hit": {
                fireRecordedEntityHit(event);
                break;
            }
            case "mob_interact": {
                fireRecordedMobInteraction(event);
                break;
            }
            case "mob_tamed": {
                const mob = event.data.mobId ? state.mobEntities.get(event.data.mobId) : undefined;
                if (mob && mob.isValid) {
                    try {
                        const tameable = mob.getComponent("minecraft:tameable");
                        if (tameable && !tameable.isTamed && state.director && state.director.isValid) {
                            tameable.tame(state.director);
                        }
                    } catch (e) {}
                }
                break;
            }
            case "mob_burning_start": {
                const mob = event.data.mobId ? state.mobEntities.get(event.data.mobId) : undefined;
                if (mob && mob.isValid) {
                    try { mob.setOnFire(2, false); } catch (e) {}
                }
                break;
            }
            case "mob_burning_stop": {
                const mob = event.data.mobId ? state.mobEntities.get(event.data.mobId) : undefined;
                if (mob && mob.isValid) {
                    try { mob.extinguishFire(false); } catch (e) {}
                }
                break;
            }
            case "breeding_hearts": {
                try {
                    state.dimension.spawnParticle("minecraft:heart_particle", event.data.location);
                } catch (e) {
                    // Cosmetic only; never stop playback if this particle isn't
                    // available on a particular Bedrock build.
                }
                break;
            }
            case "villager_profession": {
                // Profession is a native villager state. The current 2.2.0
                // Script API does not expose a generic profession setter, so
                // do not fabricate an unsupported trigger event. Preserve the
                // recorded timing with a harmless visual cue instead.
                try {
                    state.dimension.spawnParticle("replay_director:keyframe_shine", event.data.location);
                } catch (e) {}
                break;
            }
            case "player_damage":
            case "entity_damage": {
                rdLog(`eventPlayback: ${event.type} event - playerId=${event.data.playerId || "none"} attackerPlayerId=${event.data.attackerPlayerId || "none"} attackerWeaponTypeId=${event.data.attackerWeaponTypeId || "none"}`);
                const damageHitKey = `${event.tick}|${event.data.attackerPlayerId || event.data.attackerMobId || ""}|${event.data.playerId || event.data.entityId || ""}`;
                const hitAlreadyVisualized = state.hitEventKeys.has(damageHitKey);

                // Victim's hurt-flash is only fired here when a separate
                // entity_hit event did not already provide the same visual.
                // This prevents a normal melee hit from producing two hurt
                // reactions when both after-events were recorded.
                const victimActor = event.data.playerId ? state.actorEntities.get(event.data.playerId) : undefined;
                if (!hitAlreadyVisualized && victimActor) triggerHurtPulse(victimActor, system);
                const victimMob = event.data.entityId ? state.mobEntities.get(event.data.entityId) : undefined;
                if (!hitAlreadyVisualized && victimMob) triggerMobHurtReaction(victimMob, system);

                // Attacker's swing, only when the recording captured a
                // player attacker (see events.js's attackerPlayerId).
                const attackerActor = event.data.attackerPlayerId
                    ? state.actorEntities.get(event.data.attackerPlayerId)
                    : undefined;
                rdLog(`eventPlayback: ${event.type} - attackerActorFound=${!!attackerActor}`);
                const hitKey = damageHitKey;
                if (!state.hitEventKeys.has(hitKey)) {
                    state.hitEventKeys.add(hitKey);
                    if (attackerActor) triggerAttackPulse(attackerActor, system, undefined, event.data.attackerWeaponTypeId);
                }

                // Mob attacker's swing (Mob Attack Animation pass) - same
                // idea as the player attacker branch above, over
                // state.mobEntities instead of state.actorEntities, using
                // events.js's attackerMobId field (never set on the same
                // event as attackerPlayerId - an attacker is either a
                // player or a tracked mob, never both).
                const attackerMob = event.data.attackerMobId ? state.mobEntities.get(event.data.attackerMobId) : undefined;
                rdLog(`eventPlayback: ${event.type} - attackerMobFound=${!!attackerMob}`);
                if (attackerMob) triggerMobAttackPulse(attackerMob, system);

                // Mace Smash Particle pass: confirmed real vanilla particle
                // (Replay Director mace pulse particle - verified
                // against a working-particles reference list), spawned only
                // when events.js captured this specific hit as a smash
                // attack (attacker.isFalling at the moment of the hit - see
                // that file's own honesty note on the imprecision this
                // implies). Spawns at the VICTIM's current live position
                // (not event.data.location, which is where the hit
                // happened at RECORD time) - same "track the live puppet,
                // not the recorded point" reasoning as the totem_pop case
                // below, since the victim actor has since interpolated to
                // wherever this playback's timeline has it now.
                if (event.data.isMaceSmashAttack) {
                    const spawnAt = victimActor && victimActor.isValid ? victimActor.location : event.data.location;
                    try {
                        state.dimension.spawnParticle("replay_director:keyframe_shine", spawnAt);
                    } catch (e) {
                        // fail soft - a momentarily unloaded chunk shouldn't stop playback
                    }
                }
                break;
            }
            case "player_death": {
                // Only death: replay actors die exactly when (and only when)
                // the original recording contains a real death event for
                // that player - never from in-playback damage, since the
                // actor's damage_sensor blocks all real damage already.
                const actor = event.data.playerId ? state.actorEntities.get(event.data.playerId) : undefined;
                if (actor) {
                    markActorDead(actor);
                    state.deadActorPlayerIds.add(event.data.playerId);
                }
                break;
            }
            case "block_break": {
                rdLog(`eventPlayback: block_break event - playerId=${event.data.playerId || "none"} toolTypeId=${event.data.toolTypeId || "none"}`);
                const actor = event.data.playerId ? state.actorEntities.get(event.data.playerId) : undefined;
                rdLog(`eventPlayback: block_break - actorFound=${!!actor}`);
                if (actor) triggerMiningPulse(actor, system, undefined, event.data.toolTypeId);

                // Bedrock does not support a block-id argument on /particle.
                // Use a valid generic smoke burst as the safe visual fallback.
                // This intentionally does NOT claim block-texture accuracy:
                // the recorded block type remains available in beforePermutation,
                // but Bedrock's particle command/API cannot turn that typeId into
                // a vanilla block-dust emitter directly.
                if (state.dimension && event.data.location) {
                    try {
                        state.dimension.spawnParticle(
                            "minecraft:basic_smoke_particle",
                            event.data.location
                        );
                    } catch (e) {
                        // Cosmetic only - never stop replay playback if the
                        // particle is unavailable on a particular build.
                    }
                }
                break;
            }
            case "block_place": {
                rdLog(`eventPlayback: block_place event - playerId=${event.data.playerId || "none"}`);
                const actor = event.data.playerId ? state.actorEntities.get(event.data.playerId) : undefined;
                rdLog(`eventPlayback: block_place - actorFound=${!!actor}`);
                if (actor) triggerPlacePulse(actor, system);
                break;
            }
            case "block_interact": {
                // Same "an actor did something here" arm-swing cue as
                // block_place/block_break - the actual block state change
                // (e.g. a Respawn Anchor's charge count) is applied by
                // worldReplay.js from this same event, not here.
                const actor = event.data.playerId ? state.actorEntities.get(event.data.playerId) : undefined;
                if (actor) triggerPlacePulse(actor, system);
                break;
            }
            default:
                // block_explode falls through here too - its block mutation
                // is handled entirely by worldReplay.js, and there's no
                // reliable recorded player to attribute an actor pulse to
                // for an explosion (see file header).
                break;
        }
    } catch (e) {
        // fail soft - one bad event shouldn't stop the whole replay
    }
}

/**
 * Undoes a previously-fired event when a backward seek passes it - only for
 * event types that have a real, safe undo (a spawned mob can be despawned
 * again, a marked-dead actor can be revived). Arm-swing/hurt/attack/use
 * pulses and the explosion particle are momentary visual flourishes with no
 * meaningful "undone" state (they've already finished playing by the time
 * any seek could reach them) - skipping those on the way backward is
 * correct, not a gap. block_place/block_break/block_interact/block_explode
 * carry no undo here either, since worldReplay.js already owns reverting
 * the actual block mutation for all four from the same recorded events;
 * duplicating that here would be a second source of truth for the same
 * change.
 * @param {object} event
 */
function unfireEvent(event) {
    if (!state.dimension) return;

    try {
        switch (event.type) {
            case "mob_spawn":
                // Legacy generic spawn events are intentionally ignored.
                break;
            case "mob_death": {
                // Backward seeking across a supported mob death recreates the
                // controlled replay puppet, never the real vanilla mob.
                if (!event.data.entityId || !event.data.location || !event.data.entityTypeId) break;
                const existing = state.mobEntities.get(event.data.entityId);
                if (existing && existing.isValid) break;
                try {
                    const entity = spawnMobActor(
                        state.dimension,
                        event.data.location,
                        {
                            mobId: event.data.entityId,
                            typeId: event.data.entityTypeId,
                            visible: true
                        },
                        state.mobEntities.size + 1
                    );
                    if (entity) state.mobEntities.set(event.data.entityId, entity);
                } catch (e) {
                    // fail soft - fine to leave this one un-respawned
                }
                break;
            }
            case "player_death": {
                const actor = event.data.playerId ? state.actorEntities.get(event.data.playerId) : undefined;
                if (actor) {
                    reviveActor(actor);
                }
                if (event.data.playerId) {
                    state.deadActorPlayerIds.delete(event.data.playerId);
                }
                break;
            }
            default:
                // No safe/meaningful undo for this event type - see header.
                break;
        }
    } catch (e) {
        // fail soft - one bad event shouldn't stop the whole replay
    }
}
