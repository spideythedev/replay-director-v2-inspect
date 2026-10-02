/**
 * Replay Director - Playback Engine (Phase 3D core + Phase 3E controls)
 *
 * The 3D core is unchanged: one actor entity + one frame-cursor per
 * recorded player, driven by a shared tick loop, forward-cursor lookup is
 * O(1) amortized during normal playback.
 *
 * Phase 3E adds on top, without touching that core:
 * - Pause/Resume: stops/restarts the tick interval, keeping all state.
 * - Restart: resets to tick 0 and re-applies immediately.
 * - Seek/Skip: jumps to an arbitrary tick via binary search (the forward-
 *   only cursor assumption only holds during normal forward playback, so
 *   seeking uses its own lookup rather than reusing that cursor logic).
 * - Speed (0.25x-4x): simulated via a fractional tick accumulator - there
 *   is no real "slow the world down" API, so this changes how many
 *   recorded frames advance per real tick instead, per the roadmap.
 *
 * Armor & Held Item Replay pass: each actor gets a second, independent
 * cursor (actorEquipmentCursor) over its own equipment entry list, run
 * alongside the existing position cursor rather than merged into it - see
 * recordingState.js/capture.js for why equipment has its own separate
 * timeline. It advances on the same whole-tick cadence as event/world
 * replay (advanceOneWholeTick) since equipment is discrete, not something
 * renderAtPlayhead's continuous per-real-tick interpolation applies to.
 * Every entry point that already repositions the position cursor - seekTo
 * (and therefore restartPlayback/skip, and Preview Path's rewind-to-first-
 * keyframe seek in manualCameraMenu.js) - repositions the equipment cursor
 * the same way, so armor/held items stay correct across pause, resume,
 * restart, seek, timeline scrubbing, and Preview Path, at any speed,
 * exactly like position already did.
 */

import { system, world } from "@minecraft/server";
import { PROJECTILE_TYPE_IDS } from "./capture.js";
import { getReplay, getFrameData, getEquipmentFrameData, getMobFrameData, getMobEquipmentFrameData, getMobStatusFrameData, ensureFrameDataLoaded } from "./storage.js";
import {
    spawnActor,
    updateActorTransform,
    updateActorTransformInterpolated,
    updateActorAnimationState,
    triggerLandingPulse,
    removeActor,
    updateActorEquipment,
    clearActorEquipment
} from "./actors.js";
import {
    spawnMobActor,
    updateMobActorTransform,
    updateMobActorTransformInterpolated,
    updateMobActorAnimationState,
    updateMobActorEquipment,
    mobGroundSpeedExceeds,
    removeMobActor,
    killMobActor,
    triggerMobHurtReaction
} from "./mobActors.js";
import { isRecording } from "./capture.js";
import { isReplayProjectileType } from "./mobSupport.js";
import { restoreDeferredSnapshot } from "./snapshot.js";
import { beginEventPlayback, tickEventPlayback, seekEventPlayback, endEventPlayback, isActorDead } from "./eventPlayback.js";
import { beginWorldReplay, tickWorldReplay, seekWorldReplay, endWorldReplay } from "./worldReplay.js";
import { enterViewingMode, exitViewingMode } from "../core/viewingMode.js";
import { stopPathVisualization } from "../manualCamera/pathVisualizer.js";
import { isInManualStickMode, exitManualStickMode } from "../manualCamera/manualCameraSticks.js";
import { enableReplaySpawnIsolation, disableReplaySpawnIsolation } from "./spawnIsolation.js";

export const SPEED_OPTIONS = [0.01, 0.02, 0.05, 0.1, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

const playbackState = {
    active: false,
    paused: false,
    replayId: undefined,
    intervalId: undefined,
    currentTick: 0,
    totalTicks: 0,
    speed: 1,
    tickAccumulator: 0,
    /**
     * World Restore Logic polish: true only when the playhead sitting at/
     * past totalTicks got there because the user manually scrubbed
     * (seekTo/skip) to that position, not because normal forward playback
     * advanced there on its own. tickPlayback()'s natural-end check below
     * uses this to tell "the replay actually finished playing through" (a
     * real natural end - should trigger natural-end World Restore Logic)
     * apart from "the user scrubbed the timeline all the way to the end"
     * (a manual action - should NOT be silently treated as a natural end,
     * and should not by itself stop playback at all). Set in seekTo()
     * whenever the target lands at/past the end; cleared the moment
     * normal forward advancement (tickPlayback's own playheadTick +=
     * speed) is the thing pushing the playhead, or when a seek lands
     * anywhere before the end.
     */
    reachedEndViaSeek: false,
    /** Fractional recorded-tick position (e.g. 12.35) used only for smooth
     *  visual interpolation between frames - currentTick above stays the
     *  integer tick used for event firing/progress/seek, unchanged. */
    playheadTick: 0,
    /** @type {Map<string, import("@minecraft/server").Entity>} playerId -> spawned actor entity */
    actorEntities: new Map(),
    /** @type {Map<string, Array<object>>} playerId -> that actor's frame entries */
    actorEntries: new Map(),
    /** @type {Map<string, number>} playerId -> index into actorEntries */
    actorCursor: new Map(),
    /** @type {Map<string, boolean>} playerId -> whether that actor's most recently applied recorded frame had falling=true - used only to detect the falling->on-ground transition for a one-shot landing pulse */
    actorWasFalling: new Map(),
    /** @type {Map<string, Array<{startTick:number, endTick:number, equipment:object}>>} playerId -> that actor's equipment entries (Armor & Held Item Replay pass) - a separate list/cursor from actorEntries, same reasoning as recordingState's separate equipmentBuffer (armor/held-item changes far less often than position, so they get their own independent timeline instead of forcing every position entry to also carry equipment) */
    actorEquipmentEntries: new Map(),
    /** @type {Map<string, number>} playerId -> index into actorEquipmentEntries */
    actorEquipmentCursor: new Map(),
    /** @type {Map<string, object>} playerId -> the equipment snapshot last actually applied to that actor, so updateActorEquipment can skip re-setting slots that haven't changed */
    actorLastAppliedEquipment: new Map(),
    /** @type {Map<string, number|undefined>} last recorded player health applied during playback; used as a fallback hurt signal on API versions without entityHurt. */
    actorLastAppliedHealth: new Map(),

    /**
     * Mob actor playback state (Record & Replay Mobs pass) - a fully
     * parallel set of Maps to the actor* ones above, keyed by mobId
     * instead of playerId, deliberately never merged with the player
     * Maps (different population/lifecycle, same reasoning as
     * recordingState.js's mobBuffer doc comment).
     * @type {Map<string, import("@minecraft/server").Entity>} mobId -> spawned mob puppet entity
     */
    mobEntities: new Map(),
    /** @type {Map<string, Array<object>>} mobId -> that mob's frame entries */
    mobEntries: new Map(),
    /** @type {Map<string, number>} mobId -> index into mobEntries */
    mobCursor: new Map(),

    /**
     * Mob equipment playback state (Mob Equipment Sync pass) - fully
     * parallel to actorEquipmentEntries/actorEquipmentCursor/
     * actorLastAppliedEquipment above, keyed by mobId. Advances on the
     * same whole-tick cadence as position cursors, same reasoning as the
     * player equipment cursor (equipment is discrete, not something the
     * continuous per-real-tick renderer blends).
     * @type {Map<string, Array<{startTick:number, endTick:number, equipment:object}>>} mobId -> equipment entries
     */
    mobEquipmentEntries: new Map(),
    /** @type {Map<string, number>} mobId -> index into mobEquipmentEntries */
    mobEquipmentCursor: new Map(),
    /** @type {Map<string, object>} mobId -> the equipment snapshot last actually applied to that mob puppet */
    mobLastAppliedEquipment: new Map(),
    /** @type {Map<string, number|undefined>} last recorded mob health applied during playback; used as a fallback hurt signal on API versions without entityHurt. */
    mobLastAppliedHealth: new Map(),
    mobDespawnTick: new Map(),
    mobSpawnTick: new Map(),
    mobRespawnNextAttemptTick: new Map(),
    mobRecordsById: new Map(),
    mobAshTagIndex: new Map(),
    mobLastRenderedState: new Map(),
    dimension: undefined,

    /** @type {import("@minecraft/server").Player|undefined} the director who started this playback - kept so stopPlayback (called from many places, not just the director's own menu) knows whose viewing mode to restore */
    director: undefined
};

export function isPlaying() {
    return playbackState.active;
}

export function isPaused() {
    return playbackState.paused;
}

export function getPlayingReplayId() {
    return playbackState.active ? playbackState.replayId : undefined;
}

/** @returns {import("@minecraft/server").Player|undefined} the director who started the currently playing replay, or undefined if nothing is playing */
export function getPlaybackDirector() {
    return playbackState.active ? playbackState.director : undefined;
}

export function getProgress() {
    return { currentTick: playbackState.currentTick, totalTicks: playbackState.totalTicks };
}

function applyHealthHurtFallback(lastMap, id, state, entity, isMob) {
    // Only use the health-delta fallback on API versions where the native
    // entityHurt event is unavailable. Newer versions already capture the
    // exact damage event, so enabling both would double-play hurt reactions.
    const hasNativeHurtEvent = !!(world.afterEvents && world.afterEvents.entityHurt && typeof world.afterEvents.entityHurt.subscribe === "function");
    if (hasNativeHurtEvent) return;
    if (!entity || !entity.isValid || !state || typeof state.health !== "number") {
        return;
    }
    const previous = lastMap.get(id);
    const current = state.health;
    if (typeof previous === "number" && current < previous - 0.01) {
        if (isMob) {
            try { triggerMobHurtReaction(entity, system); } catch (e) {}
        } else {
            try { triggerHurtPulse(entity, system); } catch (e) {}
        }
    }
    lastMap.set(id, current);
}

/**
 * Fractional playhead position (e.g. 12.35), the same continuous value
 * renderAtPlayhead() already uses to smoothly blend actor frames between
 * ticks. Exposed read-only so other systems (Preview Path's camera driver)
 * can ride the exact same sub-tick position actors are being rendered at,
 * instead of only the whole-tick currentTick - this is what keeps the
 * camera's interpolation and the replay's interpolation visually locked
 * together at every speed, not just aligned on whole-tick boundaries.
 * @returns {number}
 */
export function getPlayheadTick() {
    return playbackState.playheadTick;
}

export function getSpeed() {
    return playbackState.speed;
}

/**
 * Read-only view of the actors currently on screen during playback, for
 * Camera Integration (Phase 3G) to offer them as a focus target. Doesn't
 * touch any playback state - just exposes what's already there.
 * @returns {Array<{playerId:string, entity:import("@minecraft/server").Entity}>}
 */
export function getActiveActors() {
    if (!playbackState.active) return [];
    const result = [];
    for (const [playerId, entity] of playbackState.actorEntities.entries()) {
        if (entity && entity.isValid) {
            result.push({ playerId, entity });
        }
    }
    return result;
}

/**
 * @param {import("@minecraft/server").Player} director
 * @param {string} replayId
 * @returns {{started:boolean, reason?:string}}
 */
export async function playReplay(director, replayId) {
    if (playbackState.active) {
        return { started: false, reason: "already_playing" };
    }
    if (isRecording()) {
        return { started: false, reason: "recording_active" };
    }

    const record = getReplay(replayId);
    if (!record) {
        return { started: false, reason: "not_found" };
    }

    // Persistent Recordings pass: hydrate in-memory frame stores from
    // persisted data if needed (normal case after a world restart, for a
    // replay that was recorded and persisted in a previous session) -
    // must happen before anything below reads frame/equipment/event data
    // for this replay. A no-op if already in memory (this session's own
    // recording, or already hydrated earlier). If this returns false,
    // frame data genuinely doesn't exist anywhere (never persisted, or
    // this replay predates the persistence feature) - playback below will
    // naturally find zero actors and fail with the existing "no_actors"
    // reason, same as it always has for a replay with no frame data.
    ensureFrameDataLoaded(replayId);

    // Every recording's snapshot is deferred now (no immediate restore at
    // record-stop anymore - see replayMenu.js/snapshot.js) - it's still
    // sitting there waiting, tied to this specific replay. Restore it now,
    // right before actors spawn, so playback always starts from the same
    // clean pre-recording state, every single time this replay is played -
    // not just the first time.
    //
    // Runs on EVERY play, not just once. This used to be guarded to only
    // ever restore once per replay (record.deferredSnapshotRestored),
    // reasoning that restoring a second time would erase blocks the actor
    // built during the FIRST playthrough. That reasoning no longer holds:
    // worldReplay.js's endWorldReplay() (see that file) used to undo every
    // block change when playback stopped, which meant an in-recording
    // build only ever existed transiently during a single playthrough
    // anyway - restoring the pre-recording snapshot before the NEXT
    // playthrough couldn't lose anything that wasn't already gone. Now
    // that endWorldReplay() leaves blocks permanent after playback ends,
    // skipping this restore on repeat plays instead left the PREVIOUS
    // playthrough's leftover blocks sitting in the world when a NEW
    // playthrough started, since the actor always re-places the exact
    // same recorded blocks (deterministic, from afterPermutation
    // snapshots in events.js - never derived from current world state),
    // so there was never anything to actually "lose" by restoring first;
    // restoring first is what correctly clears the leftovers before the
    // actor rebuilds them fresh.
    if (record.deferredSnapshot) {
        const restored = await restoreDeferredSnapshot(record.deferredSnapshot);
        if (!restored.blocksRestored && record.deferredSnapshot.blocksSnapshotted) {
            return { started: false, reason: "world_restore_failed" };
        }
    }

    const frames = getFrameData(replayId);
    if (!frames) {
        return { started: false, reason: "no_frame_data" };
    }

    // Replay Spawn Isolation: use the exact restored snapshot bounds. This
    // remains the fixed 62x62x62 world region; the mob recording radius may
    // be larger, but it must not enlarge the world-isolation region.
    const spawnIsolationBounds = record.deferredSnapshot?.from && record.deferredSnapshot?.to
        ? {
            from: { ...record.deferredSnapshot.from },
            to: { ...record.deferredSnapshot.to },
            dimensionId: record.deferredSnapshot.dimensionId
        }
        : (record.recordingBounds?.from && record.recordingBounds?.to
            ? {
                from: { ...record.recordingBounds.from },
                to: { ...record.recordingBounds.to },
                dimensionId: record.recordingBounds.dimensionId
            }
            : undefined);

    if (spawnIsolationBounds) {
        enableReplaySpawnIsolation(spawnIsolationBounds);
    }

    // Equipment frames are optional (older saved replays recorded before
    // the Armor & Held Item Replay pass simply won't have any) - an actor
    // with no equipment data just spawns/stays in whatever default state
    // spawnActor() leaves it in, same as it always has.
    const equipmentFrames = getEquipmentFrameData(replayId);

    const dimension = director.dimension;
    const actorEntities = new Map();
    const actorEntries = new Map();
    const actorCursor = new Map();
    const actorWasFalling = new Map();
    const actorEquipmentEntries = new Map();
    const actorEquipmentCursor = new Map();
    const actorLastAppliedEquipment = new Map();

    for (const actor of record.actors) {
        const entries = frames.get(actor.playerId);
        if (!entries || entries.length === 0) continue;

        const firstState = entries[0].state;
        const spawnState = entries.find((entry) => !entry.state.dimensionId || entry.state.dimensionId === dimension.id)?.state;
        if (!spawnState) continue;
        const ashTagIndex = actorEntities.size + 1;
        const entity = spawnActor(dimension, { x: spawnState.x, y: spawnState.y, z: spawnState.z }, actor, ashTagIndex);
        if (!entity) continue;

        actorEntities.set(actor.playerId, entity);
        actorEntries.set(actor.playerId, entries);
        actorCursor.set(actor.playerId, 0);
        actorWasFalling.set(actor.playerId, !!firstState.falling);

        const equipmentEntries = equipmentFrames ? equipmentFrames.get(actor.playerId) : undefined;
        if (equipmentEntries && equipmentEntries.length > 0) {
            actorEquipmentEntries.set(actor.playerId, equipmentEntries);
            actorEquipmentCursor.set(actor.playerId, 0);
            // Deferred one tick: a freshly spawned entity isn't always
            // ready for entity.runCommand() on the very tick it spawns -
            // running /replaceitem immediately can silently no-op
            // (successCount 0) even though spawnEntity() itself succeeded.
            system.run(() => {
                if (!entity || !entity.isValid) return;
                const applied = updateActorEquipment(entity, equipmentEntries[0].equipment, undefined);
                actorLastAppliedEquipment.set(actor.playerId, applied);
            });
        } else {
            // No recorded equipment means "no equipment data", not "clear
            // every slot". spawnActor() may have a deliberate manual armor
            // override, so do not erase it and do not issue unnecessary
            // /replaceitem commands.
        }
    }

    if (actorEntities.size === 0) {
        disableReplaySpawnIsolation();
        return { started: false, reason: "no_actors" };
    }

    // Mob actors (Record & Replay Mobs pass, extended by the Mob
    // Equipment Sync pass): a fully parallel spawn loop to the player one
    // above, over record.mobs instead of record.actors, using its own
    // frame sources (getMobFrameData, getMobEquipmentFrameData) and its
    // own spawn function (spawnMobActor, which picks the puppet entity
    // type from mobSupport.js and now also assigns an ashN-style tag - see
    // that file's own header for why the tag range is offset). A replay
    // with zero recorded mobs (any replay saved before this feature
    // existed, or one where nothing in range was ever a supported type)
    // simply has record.mobs === [] (see saveReplayFromRecording's
    // default) and this loop is a no-op - NOT a failure condition the way
    // zero player actors is, since a replay can be perfectly valid with no
    // mobs at all.
    const mobFrames = getMobFrameData(replayId);
    const mobEquipmentFrames = getMobEquipmentFrameData(replayId);
    const mobStatusFrames = getMobStatusFrameData(replayId);
    const mobEntities = new Map();
    const mobEntries = new Map();
    const mobCursor = new Map();
    const mobEquipmentEntries = new Map();
    const mobEquipmentCursor = new Map();
    const mobStatusEntries = new Map();
    const mobStatusCursor = new Map();
    const mobLastAppliedEquipment = new Map();
    const mobLastRenderedState = new Map();
    playbackState.mobDespawnTick = new Map();
    playbackState.mobDespawnReason = new Map();
    playbackState.mobSpawnTick = new Map();
    playbackState.mobRespawnNextAttemptTick = new Map();
    playbackState.mobRecordsById = new Map();
    playbackState.mobAshTagIndex = new Map();

    let mobOrdinal = 0;
    const replayMobRecords = [
        ...(record.mobs || []),
        // New recordings store projectiles separately from mobs, but both
        // use the same transform/lifecycle buffer for exact timing/seek.
        ...(record.projectiles || [])
    ];
    // Backward compatibility: older recordings that incorrectly placed
    // projectiles in `mobs` are also restored now through the dedicated
    // visual projectile puppets.
    for (const mobRecord of replayMobRecords) {
        // Older recordings may contain projectile types that this build does
        // not have a dedicated visual puppet for. Never fall back to a real
        // projectile spawn because some engine-owned projectile identifiers
        // (notably Ender Pearl) reject Dimension.spawnEntity().
        if (mobRecord && PROJECTILE_TYPE_IDS.has(mobRecord.typeId) && !isReplayProjectileType(mobRecord.typeId)) {
            continue;
        }
        const entries = mobFrames ? mobFrames.get(mobRecord.mobId) : undefined;
        if (!entries || entries.length === 0) continue;

        mobOrdinal += 1;
        const ashTagIndex = mobOrdinal;

        mobEntries.set(mobRecord.mobId, entries);
        mobCursor.set(mobRecord.mobId, 0);
        playbackState.mobSpawnTick.set(mobRecord.mobId, entries[0].startTick);
        playbackState.mobDespawnTick.set(mobRecord.mobId, typeof mobRecord.despawnTick === "number" ? mobRecord.despawnTick : null);
        playbackState.mobDespawnReason.set(mobRecord.mobId, mobRecord.despawnReason || null);
        playbackState.mobRecordsById.set(mobRecord.mobId, mobRecord);
        playbackState.mobAshTagIndex.set(mobRecord.mobId, ashTagIndex);

        const mobEquipEntries = mobEquipmentFrames ? mobEquipmentFrames.get(mobRecord.mobId) : undefined;
        if (mobEquipEntries && mobEquipEntries.length > 0) {
            mobEquipmentEntries.set(mobRecord.mobId, mobEquipEntries);
            mobEquipmentCursor.set(mobRecord.mobId, 0);
        }
        const mobStatusEntriesForMob = mobStatusFrames ? mobStatusFrames.get(mobRecord.mobId) : undefined;
        if (mobStatusEntriesForMob && mobStatusEntriesForMob.length > 0) {
            mobStatusEntries.set(mobRecord.mobId, mobStatusEntriesForMob);
            mobStatusCursor.set(mobRecord.mobId, 0);
        }
    }

    playbackState.active = true;
    playbackState.paused = false;
    playbackState.replayId = replayId;
    playbackState.currentTick = 0;
    playbackState.totalTicks = Math.max(1, record.frameCount);
    playbackState.speed = 1;
    playbackState.tickAccumulator = 0;
    playbackState.playheadTick = 0;
    playbackState.reachedEndViaSeek = false;
    playbackState.actorEntities = actorEntities;
    playbackState.actorEntries = actorEntries;
    playbackState.actorCursor = actorCursor;
    playbackState.actorWasFalling = actorWasFalling;
    playbackState.actorEquipmentEntries = actorEquipmentEntries;
    playbackState.actorEquipmentCursor = actorEquipmentCursor;
    playbackState.actorLastAppliedEquipment = actorLastAppliedEquipment;
    playbackState.mobEntities = mobEntities;
    playbackState.mobEntries = mobEntries;
    playbackState.mobCursor = mobCursor;
    playbackState.mobEquipmentEntries = mobEquipmentEntries;
    playbackState.mobEquipmentCursor = mobEquipmentCursor;
    playbackState.mobStatusEntries = mobStatusEntries;
    playbackState.mobStatusCursor = mobStatusCursor;
    playbackState.mobLastAppliedEquipment = mobLastAppliedEquipment;
    playbackState.mobLastRenderedState = mobLastRenderedState;
    playbackState.director = director;

    playbackState.intervalId = system.runInterval(() => tickPlayback(), 1);

    playbackState.dimension = dimension;
    syncMobLifecycle(0);
    beginEventPlayback(replayId, dimension, actorEntities, mobEntities, director);
    beginWorldReplay(replayId, dimension);
    // Manual Camera Mode Sticks safety net: if this director happens to
    // still be holding Manual Camera sticks (stick mode only activates
    // with nothing playing, but Main Menu/Replay List remain reachable
    // from that state - see manualCameraMenu.js/manualCameraSticks.js),
    // release that tracking cleanly BEFORE viewingMode.js's own
    // clearAll() would otherwise wipe those sticks without ever calling
    // exitManualStickMode. No-ops instantly if this player isn't in
    // stick mode, which is the overwhelmingly common case.
    if (isInManualStickMode(director.id)) {
        exitManualStickMode(director);
    }
    enterViewingMode(director);

    return { started: true };
}

function tickPlayback() {
    // World Restore Logic polish: capture whether the playhead was ALREADY
    // sitting at/past the end because of a manual scrub, before this
    // tick's own forward-advancement runs. This is the value that
    // matters for the end-check below - if the user scrubbed here and
    // playback hasn't genuinely moved since, every subsequent tick would
    // otherwise keep re-triggering stopPlayback() purely because the playhead happens to already
    // be sitting at the boundary, not because playback actually finished.
    const wasAlreadyAtEndViaSeek = playbackState.reachedEndViaSeek;

    // The playhead advances by `speed` EVERY real tick, no matter how small
    // `speed` is - this is what makes 0.01x-0.25x smooth instead of choppy.
    // The old approach only moved (and only rendered) once a whole recorded
    // tick had "accumulated," so most real ticks did nothing at slow speeds
    // and the actor visibly froze between jumps. Now every real tick moves
    // the fractional playhead a little and re-renders an interpolated blend
    // between the two recorded frames it currently sits between - so the
    // actor is always moving smoothly, just by tinier amounts at low speed.
    playbackState.playheadTick += playbackState.speed;

    const clampedPlayhead = Math.max(0, Math.min(playbackState.totalTicks, playbackState.playheadTick));
    playbackState.playheadTick = clampedPlayhead;

    renderAtPlayhead(clampedPlayhead);

    // Whole-tick bookkeeping (events, integer currentTick, stop condition)
    // still only fires when the playhead actually crosses an integer tick
    // boundary - this keeps event timing and progress reporting exactly as
    // accurate as before; only the visual side is now continuous.
    playbackState.tickAccumulator += playbackState.speed;
    while (playbackState.tickAccumulator >= 1 && playbackState.active) {
        playbackState.tickAccumulator -= 1;
        advanceOneWholeTick();
    }

    if (playbackState.active && clampedPlayhead >= playbackState.totalTicks) {
        // World Restore Logic polish: only a genuine forward-playback
        // arrival at the end counts as a natural end. If the playhead was
        // already parked at the end by a manual scrub (seekTo/skip) and
        // hasn't moved since, this is not the replay "finishing on its
        // own" - it's the user having scrubbed there, and should not
        // trigger stopPlayback at all (paused playback sitting at the end
        // just... sits there, same as sitting anywhere else, until the
        // user takes an action). Once this check has run, always clear
        // the flag - either it just correctly suppressed a scrub-parked
        // tick (and the next tick should re-evaluate fresh, e.g. if the
        // user scrubs backward off the end), or it was already false and
        // clearing it is a no-op.
        if (!wasAlreadyAtEndViaSeek) {
            stopPlayback();
        }
        playbackState.reachedEndViaSeek = false;
    }
}

/** Whole-tick-only bookkeeping: integer currentTick, cursor advance for event lookups, discrete event firing, and landing-pulse detection. No continuous visual work here anymore - renderAtPlayhead already handled that. */
function advanceOneWholeTick() {
    playbackState.currentTick++;
    try { syncMobLifecycle(playbackState.currentTick); } catch (e) {}

    for (const [playerId, entity] of playbackState.actorEntities.entries()) {
        if (!entity || !entity.isValid) continue;
        const entries = playbackState.actorEntries.get(playerId);
        let cursor = playbackState.actorCursor.get(playerId);
        while (cursor < entries.length - 1 && playbackState.currentTick > entries[cursor].endTick) {
            cursor++;
        }
        playbackState.actorCursor.set(playerId, cursor);

        // Landing pulse: fires once, exactly when the recording shows the
        // player going from falling to on-ground - a real captured
        // transition, not a guessed one.
        const state = entries[cursor].state;
        const wasFalling = playbackState.actorWasFalling.get(playerId);
        if (wasFalling && state.onGround && !isActorDead(playerId)) {
            triggerLandingPulse(entity, system);
        }
        playbackState.actorWasFalling.set(playerId, !!state.falling);

        // Equipment: armor/held items are discrete (there's nothing to
        // visually interpolate between "sword" and "no sword"), so this
        // advances on the same whole-tick cadence as events/world replay,
        // not the continuous per-real-tick renderAtPlayhead loop - it's
        // still exactly recorded-timestamp-accurate because currentTick
        // only advances here, once per crossed recorded tick, at every
        // playback speed. updateActorEquipment() itself is a no-op unless
        // the cursor actually moved onto a different equipment entry, so
        // this costs nothing extra on the (overwhelming majority of) ticks
        // where equipment hasn't changed.
        const equipmentEntries = playbackState.actorEquipmentEntries.get(playerId);
        if (equipmentEntries && equipmentEntries.length > 0) {
            let equipmentCursor = playbackState.actorEquipmentCursor.get(playerId) ?? 0;
            while (
                equipmentCursor < equipmentEntries.length - 1 &&
                playbackState.currentTick > equipmentEntries[equipmentCursor].endTick
            ) {
                equipmentCursor++;
            }
            playbackState.actorEquipmentCursor.set(playerId, equipmentCursor);

            const lastApplied = playbackState.actorLastAppliedEquipment.get(playerId);
            const applied = updateActorEquipment(entity, equipmentEntries[equipmentCursor].equipment, lastApplied);
            playbackState.actorLastAppliedEquipment.set(playerId, applied);
        }
    }

    // Mob cursor advance (Record & Replay Mobs pass, extended by the Mob
    // Equipment Sync pass): same whole-tick forward-cursor advance as the
    // player loop above, over its own parallel Maps. Mobs have no
    // landing-pulse/death-pose concepts in v1, so position cursor advance
    // is just the cursor bookkeeping - the actual visual/animation update
    // happens in renderAtPlayhead below, same split as players (this
    // function only does discrete per-whole-tick work; continuous visual
    // blending lives in the playhead renderer). Equipment, like the
    // player equipment pass above, IS fully handled right here (discrete,
    // not blended).
    for (const [mobId, entity] of playbackState.mobEntities.entries()) {
        if (entity === undefined || entity === null) continue;
        let entityValid = false;
        try {
            entityValid = entity.isValid === true;
        } catch (e) {
            entityValid = false;
        }
        if (!entityValid) continue;
        const entries = playbackState.mobEntries.get(mobId);
        if (!entries || entries.length === 0) continue;
        let cursor = playbackState.mobCursor.get(mobId) ?? 0;
        cursor = Math.max(0, Math.min(cursor, entries.length - 1));
        while (cursor < entries.length - 1 && playbackState.currentTick > entries[cursor].endTick) {
            cursor++;
        }
        playbackState.mobCursor.set(mobId, cursor);

        const equipmentEntries = playbackState.mobEquipmentEntries.get(mobId);
        if (equipmentEntries && equipmentEntries.length > 0) {
            let equipmentCursor = playbackState.mobEquipmentCursor.get(mobId) ?? 0;
            while (
                equipmentCursor < equipmentEntries.length - 1 &&
                playbackState.currentTick > equipmentEntries[equipmentCursor].endTick
            ) {
                equipmentCursor++;
            }
            playbackState.mobEquipmentCursor.set(mobId, equipmentCursor);

            const lastApplied = playbackState.mobLastAppliedEquipment.get(mobId);
            const applied = updateMobActorEquipment(entity, equipmentEntries[equipmentCursor].equipment, lastApplied);
            playbackState.mobLastAppliedEquipment.set(mobId, applied);
        }
    }

    tickEventPlayback(playbackState.currentTick);
    tickWorldReplay(playbackState.currentTick);
}

/**
 * Renders every actor's position/rotation as a smooth blend between the two
 * recorded frames that bracket the given fractional playhead position.
 * @param {number} playhead - fractional recorded-tick position
 */
function isStateInPlaybackDimension(state) {
    if (!state) return false;
    if (!state.dimensionId) return true; // backward-compatible older replays
    const director = playbackState.director;
    if (!director || !director.isValid) return false;
    try {
        return state.dimensionId === director.dimension.id;
    } catch (e) {
        return false;
    }
}

function renderAtPlayhead(playhead) {
    for (const [playerId, entity] of playbackState.actorEntities.entries()) {
        if (!entity || !entity.isValid) continue;

        const entries = playbackState.actorEntries.get(playerId);
        if (!entries || entries.length === 0) continue;

        const cursor = playbackState.actorCursor.get(playerId) ?? 0;
        const currentEntry = entries[cursor];
        const nextEntry = entries[cursor + 1];

        // Safe dimension segmentation: replay actors only receive transforms
        // from the director's current dimension. When a recorded actor enters
        // another dimension, hold its last valid transform instead of
        // teleporting Nether/End coordinates into the current dimension.
        if (!isStateInPlaybackDimension(currentEntry.state)) {
            continue;
        }
        if (nextEntry && (!isStateInPlaybackDimension(nextEntry.state) || nextEntry.startTick > currentEntry.endTick + 1)) {
            updateActorTransform(entity, { x: currentEntry.state.x, y: currentEntry.state.y, z: currentEntry.state.z }, { pitch: currentEntry.state.pitch, yaw: currentEntry.state.yaw });
            updateActorAnimationState(entity, currentEntry.state);
            continue;
        }

        // Blend within the current entry's own tick range (a held/unchanged
        // frame has fromState === toState, so this is a no-op lerp there),
        // and if the playhead has moved into the next entry's range already,
        // blend towards that instead - keeps motion continuous across the
        // boundary between two recorded (possibly run-length-encoded) entries.
        let fromState = currentEntry.state;
        let toState = currentEntry.state;
        let t = 0;

        if (nextEntry && playhead > currentEntry.endTick) {
            const span = nextEntry.startTick - currentEntry.endTick || 1;
            t = (playhead - currentEntry.endTick) / span;
            fromState = currentEntry.state;
            toState = nextEntry.state;
        } else {
            const span = (currentEntry.endTick - currentEntry.startTick) || 1;
            const within = playhead - currentEntry.startTick;
            if (nextEntry) {
                t = Math.max(0, Math.min(1, within / span));
                toState = nextEntry.state;
            }
            // else: last entry, nothing to blend towards - hold fromState.
        }

        if (isActorDead(playerId)) {
            // Death pose already set (and held) by markActorDead - keep
            // following recorded position only (e.g. a brief post-death
            // slide), but don't let normal playback rotation un-tilt it.
            const x = lerp(fromState.x, toState.x, Math.max(0, Math.min(1, t)));
            const y = lerp(fromState.y, toState.y, Math.max(0, Math.min(1, t)));
            const z = lerp(fromState.z, toState.z, Math.max(0, Math.min(1, t)));
            try {
                entity.teleport({ x, y, z });
            } catch (e) {
                // fail soft
            }
            continue;
        }

        applyHealthHurtFallback(playbackState.actorLastAppliedHealth, playerId, currentEntry.state, entity, false);
        updateActorTransformInterpolated(entity, fromState, toState, t);
        // Animation state (moving/sprinting/etc) is boolean-driven, not
        // continuous, so it still just reflects whichever recorded frame
        // we're currently at/past - no meaningful "blend" for a bool.
        updateActorAnimationState(entity, currentEntry.state);
    }

    renderMobsAtPlayhead(playhead);
}

/**
 * Mob rendering pass (Record & Replay Mobs pass) - fully parallel to
 * renderAtPlayhead above (same blend-between-two-recorded-frames logic),
 * over playbackState's mob* Maps instead of actor* Maps. Kept as its own
 * function rather than folded into the loop above, per the feature
 * request's explicit instruction to build this as a separate path
 * alongside players, not merged into the existing per-player loop.
 * @param {number} playhead - fractional recorded-tick position
 */
function renderMobsAtPlayhead(playhead) {
    for (const [mobId, entity] of playbackState.mobEntities.entries()) {
        // Entity references can disappear asynchronously when a mob dies,
        // is removed, or a seek crosses its lifecycle boundary. Never read
        // .isValid until the reference itself has been proven to exist.
        if (entity === undefined || entity === null) continue;
        let entityValid = false;
        try {
            entityValid = entity.isValid === true;
        } catch (e) {
            entityValid = false;
        }
        if (!entityValid) continue;

        const entries = playbackState.mobEntries.get(mobId);
        if (!entries || entries.length === 0) continue;

        const cursor = Math.max(0, Math.min(
            playbackState.mobCursor.get(mobId) ?? 0,
            entries.length - 1
        ));
        const currentEntry = entries[cursor];
        if (!currentEntry || !currentEntry.state) continue;
        const nextEntry = entries[cursor + 1];

        let fromState = currentEntry.state;
        let toState = currentEntry.state;
        let t = 0;

        if (nextEntry && playhead > currentEntry.endTick) {
            const span = nextEntry.startTick - currentEntry.endTick || 1;
            t = (playhead - currentEntry.endTick) / span;
            fromState = currentEntry.state;
            toState = nextEntry.state;
        }
        // else: playhead is still inside the current entry's own recorded
        // span (before its endTick) - hold exactly at fromState/t=0. This
        // used to blend toward nextEntry across the ENTIRE held span
        // (using (playhead - startTick) / (endTick - startTick) as t),
        // which visibly drifted the puppet toward its next real position
        // for the whole time it was supposed to be standing still, then
        // snapped at the boundary - a real bug, just far more visible for
        // mobs than players because mob RLE entries collapse into much
        // longer unchanged spans (mobs stand still far more than players
        // do), so the drift had much more distance/time to be seen.
        // Mobs have no recorded velocity field (see capture.js's
        // buildMobState) - "moving" is derived from ground distance
        // between the two bracketing recorded frames instead, which is a
        // fine proxy since mob capture already only records a new entry
        // when position/rotation actually changed (RLE - see
        // recordingState.js), so fromState !== toState here already means
        // real recorded movement happened across this span.
        applyHealthHurtFallback(playbackState.mobLastAppliedHealth, mobId, fromState, entity, true);
        updateMobActorTransformInterpolated(entity, fromState, toState, t);
        applyMobHealth(entity, fromState);
        applyMobViewDirection(entity, fromState);
        applyMobStatusAtTick(entity, mobId, Math.floor(playhead));
        updateMobActorAnimationState(entity, mobGroundSpeedExceeds(fromState, toState));
    }
}

function applyMobViewDirection(entity, state) {
    if (!entity || !entity.isValid || !state) return;
    if (typeof state.viewX !== "number" || typeof state.viewY !== "number" || typeof state.viewZ !== "number") return;
    try {
        const length = Math.hypot(state.viewX, state.viewY, state.viewZ) || 1;
        const target = {
            x: entity.location.x + (state.viewX / length) * 8,
            y: entity.location.y + (state.viewY / length) * 8,
            z: entity.location.z + (state.viewZ / length) * 8
        };
        entity.lookAt(target);
    } catch (e) {}
}

function applyMobHealth(entity, state) {
    if (!entity || !entity.isValid || !state || typeof state.health !== "number") return;
    try {
        const health = entity.getComponent("minecraft:health");
        if (health) health.setCurrentValue(Math.max(0.01, Math.min(health.effectiveMax, state.health)));
    } catch (e) {}
}

function applyMobStatusAtTick(entity, mobId, tick) {
    if (!entity || !entity.isValid) return;
    const entries = playbackState.mobStatusEntries.get(mobId);
    if (!entries || entries.length === 0) return;

    const index = Math.max(0, Math.min(entries.length - 1, findEntryIndexForTick(entries, tick)));
    const entry = entries[index];
    if (!entry || !entry.status) return;

    const status = entry.status;
    try {
        if (status.onFire) {
            entity.setOnFire(2, false);
        } else {
            entity.extinguishFire(false);
        }
    } catch (e) {}

    if (status.isTamed) {
        try {
            const tameable = entity.getComponent("minecraft:tameable");
            if (tameable && !tameable.isTamed && playbackState.director && playbackState.director.isValid) {
                tameable.tame(playbackState.director);
            }
        } catch (e) {}
    }
}

/** Snaps an actor exactly to one recorded frame - used by seek/restart, which are deliberate jumps and should not blend. */
function applyEntry(entity, entry) {
    const state = entry.state;
    if (!isStateInPlaybackDimension(state)) return;
    updateActorTransform(entity, { x: state.x, y: state.y, z: state.z }, { pitch: state.pitch, yaw: state.yaw });
    updateActorAnimationState(entity, state);
}

/** Same as applyEntry above but for a mob puppet - snaps exactly, no blend, and has no equivalent of the player's rich animation-state object (see mobActors.js's updateMobActorAnimationState, which just takes a moving bool). A snap has nothing to derive "moving" from (there's no previous frame in this context), so it conservatively reports not-moving - the very next renderMobsAtPlayhead call (which runs immediately after every seek, same as applyCurrentFrame does for players) will correct this from the two bracketing frames a moment later. */
function applyMobEntry(entity, entry) {
    const state = entry.state;
    updateMobActorTransform(entity, { x: state.x, y: state.y, z: state.z }, { pitch: state.pitch, yaw: state.yaw });
    applyMobHealth(entity, state);
    applyMobViewDirection(entity, state);
    updateMobActorAnimationState(entity, false);
}

/** Re-applies every actor's current frame immediately, instead of waiting for the next tick. */
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

        for (const key of Object.keys(EQUIPMENT_SLOT_KEYS)) {
            try {
                const slot = equippable.getEquipmentSlot(EQUIPMENT_SLOT_KEYS[key]);
                snapshot[key] = slot && slot.hasItem() ? snapshotItemStack(slot.getItem()) : undefined;
            } catch (e) {
                snapshot[key] = undefined;
            }
        }

        const nonEmpty = Object.entries(snapshot).filter(([, v]) => v).map(([k, v]) => `${k}=${v.typeId}`);
        if (nonEmpty.length > 0) {
            rdLog(`buildMobEquipmentSnapshot: mob typeId="${mob.typeId}" id=${mob.id} recorded this tick: ${nonEmpty.join(", ")}`);
        }

        // Always-visible mainhand capture confirmation retired (Equipment
        // Diagnosis pass, closed out) - it served its purpose: real
        // testing (a screenshot showing "ash1" - a PLAYER actor tag, not
        // a mob one - correctly reporting the player's own held item
        // changing as they switched hotbar slots) confirmed this whole
        // pipeline genuinely works. Left as a normal debug-mode-only
        // rdLog below instead of removed entirely, in case it's ever
        // needed again, but no longer spams every item switch by default.
        if (snapshot.mainhand) {
            rdLog(`buildMobEquipmentSnapshot: mob typeId="${mob.typeId}" (id=${mob.id}) mainhand -> "${snapshot.mainhand.typeId}".`);
        }
    } catch (e) {
        // fail soft - snapshot stays whatever slots were read before the failure
    }
    return snapshot;
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
    for (const entries of recordingState.mobBuffer.values()) {
        mobEntryCount += entries.length;
        mobApproxBytes += JSON.stringify(entries).length;
    }
    return {
        frameCount: recordingState.tick,
        playerCount: recordingState.buffer.size,
        entryCount,
        approxBytes: approxBytes + mobApproxBytes,
        // Mob-specific fields, additive - existing callers reading
        // frameCount/playerCount/entryCount/approxBytes/allocated keep
        // working unchanged (see storage.js's saveReplayFromRecording).
        mobCount: recordingState.mobBuffer.size,
        mobEntryCount,
        allocated: recordingState.pendingReplayId
    };
}

/**
 * Spawn/despawn sync (Generic Ambient Mob Capture pass; extended by the
 * Spawn-Tick Gating pass) - this is now the ONLY place mob entities are
 * ever spawned or removed during playback, including the very first time
 * (beginPlayback calls this once at tick 0 instead of eagerly spawning
 * every recorded mob upfront). Two independent boundaries per mob:
 *   - spawnTick (entries[0].startTick): the mob wasn't there yet before
 *     this recording-relative tick, so it shouldn't be visible before it
 *     either - a mob spawned mid-recording (egg use, natural spawn, a
 *     villager/wandering trader that only wandered into range later) now
 *     visibly appears at the SAME relative moment during playback, rather
 *     than being present from the very start of the replay.
 *   - despawnTick (recorded death/removal tick, or null if still alive
 *     when recording stopped): see this file's earlier despawn-tracking
 *     work.
 *
 * IMPORTANT reliability property, added after a real observed bug: this
 * function must NEVER let one mob's failure affect any other mob, and
 * must NEVER be allowed to throw out to its caller - advanceOneWholeTick
 * calls this BEFORE the player actor position-update loop every tick, so
 * an uncaught exception here previously aborted that tick's player
 * movement update entirely; if the same failure repeated every
 * subsequent tick (which a naive infinite-retry-every-tick spawn attempt
 * easily does), the player appeared permanently frozen from that point
 * on. Every per-mob body below is individually try/caught, and a failed
 * spawn attempt is backed off (retried at most once per
 * RESPAWN_RETRY_INTERVAL_TICKS, not every single tick) rather than
 * hammering dimension.spawnEntity() forever.
 * @param {number} tick current playbackState.currentTick (or seek target)
 */
function syncMobLifecycle(tick) {
    for (const [mobId, despawnTick] of playbackState.mobDespawnTick.entries()) {
        try {
            const spawnTick = playbackState.mobSpawnTick.get(mobId) ?? 0;
            const shouldExist = tick >= spawnTick && (despawnTick === null || despawnTick === undefined || tick < despawnTick);

            const entity = playbackState.mobEntities.get(mobId);
            let currentlyExists = false;
            if (entity !== undefined && entity !== null) {
                try {
                    currentlyExists = entity.isValid === true;
                } catch (e) {
                    currentlyExists = false;
                }
            }

            if (!shouldExist && currentlyExists) {
                // A real recorded death (crossed despawnTick going
                // forward) gets the real death effect (see
                // this mob's OWN spawnTick (it "hasn't been born yet"
                // from this point in the timeline) is a different case
                // entirely and must stay a silent removal, not a death.
                //
                // Projectiles (Ambient Projectile Capture pass) are
                // excluded from the death-effect path even on a real
                // despawn - a real vanilla arrow just silently disappears
                // when it's consumed by a hit (destroy_on_hit), it doesn't
                // play a mob-style death particle/flop/sound, so giving it
                // one would look wrong, not like a natural Minecraft
                // moment. mobRecordsById is looked up (not the live
                // entity's own tag) so this decision is stable even if the
                // entity itself was already set to undefined/removed.
                const mobRecord = playbackState.mobRecordsById.get(mobId);
                const isProjectile = !!mobRecord && PROJECTILE_TYPE_IDS.has(mobRecord.typeId);
                const despawnReason = playbackState.mobDespawnReason.get(mobId);
                const isRealDeath = !isProjectile &&
                    despawnReason !== "scope_exit" &&
                    despawnReason !== "remove" &&
                    despawnTick !== null &&
                    despawnTick !== undefined &&
                    tick >= despawnTick;
                if (isRealDeath) {
                    killMobActor(entity, system, isPaused);
                } else {
                    removeMobActor(entity);
                }
                playbackState.mobEntities.delete(mobId);
                playbackState.mobRespawnNextAttemptTick.delete(mobId);
                playbackState.mobLastAppliedEquipment.delete(mobId);
                playbackState.mobStatusCursor.delete(mobId);
                playbackState.mobLastRenderedState.delete(mobId);
            } else if (shouldExist && !currentlyExists) {
                const nextAttempt = playbackState.mobRespawnNextAttemptTick.get(mobId);
                if (nextAttempt !== undefined && tick < nextAttempt) continue; // backed off - not due for another attempt yet, see file header
                respawnMob(mobId, tick);
            }
        } catch (e) {
            // A single mob's lifecycle failure must never take down the
            // rest of the tick (see this function's own header) - back it
            // off the same as a normal spawn failure so it doesn't retry
            // every tick, and move on to the next mob.
            playbackState.mobRespawnNextAttemptTick.set(mobId, tick + RESPAWN_RETRY_INTERVAL_TICKS);
        }
    }
}

/** Minimum recorded-ticks between repeated respawn attempts for the same mob once one attempt has failed - protects against hammering dimension.spawnEntity() every single tick if a mob's recorded spawn location stays obstructed (e.g. world block-replay put terrain back before the mob's spot cleared again), which was the confirmed root cause of a real "player permanently stuck" bug. 20 ticks = 1 real-time second at normal playback speed. */
const RESPAWN_RETRY_INTERVAL_TICKS = 20;

/**
 * Spawns (or re-spawns) a mob puppet/generic entity for the given mobId at
 * the frame matching `tick`. Used both for a mob's very first appearance
 * (spawn-tick gating) and for bringing back a previously despawned/dead
 * mob on a backward seek - both are the exact same operation now (see
 * syncMobLifecycle's header). On failure, records a backed-off retry time
 * instead of leaving the mob to be retried unconditionally on the very
 * next tick.
 * @param {string} mobId
 * @param {number} tick
 */
function respawnMob(mobId, tick) {
    if (!playbackState.dimension) return;
    const mobRecord = playbackState.mobRecordsById.get(mobId);
    const entries = playbackState.mobEntries.get(mobId);
    const ashTagIndex = playbackState.mobAshTagIndex.get(mobId);
    if (!mobRecord || !entries || entries.length === 0) return;

    const index = Math.max(0, Math.min(entries.length - 1, findEntryIndexForTick(entries, tick)));
    const state = entries[index].state;

    let entity;
    try {
        entity = spawnMobActor(playbackState.dimension, { x: state.x, y: state.y, z: state.z }, mobRecord, ashTagIndex);
    } catch (e) {
        entity = undefined;
    }

    if (!entity) {
        playbackState.mobRespawnNextAttemptTick.set(mobId, tick + RESPAWN_RETRY_INTERVAL_TICKS);
        return;
    }

    playbackState.mobRespawnNextAttemptTick.delete(mobId);
    playbackState.mobEntities.set(mobId, entity);
    playbackState.mobCursor.set(mobId, index);
    applyMobEntry(entity, entries[index]);
    applyMobStatusAtTick(entity, mobId, tick);
    playbackState.mobLastRenderedState.delete(mobId); // fresh (re)spawn - next render tick shouldn't compare against a stale pre-despawn position and falsely detect "moving"

    // Equipment (corrected after a real, now-confirmed root cause -
    // cross-referenced against ReplayCraft's own shipped, working
    // approach, which does NOT touch mob equipment via script AT ALL:
    // a plain dimension.spawnEntity("minecraft:skeleton", ...) already
    // comes holding its real vanilla default bow, with zero extra
    // scripting needed, and ReplayCraft simply never interferes with
    // that). This used to ALWAYS call updateMobActorEquipment, even with
    // a completely empty {} map when nothing was ever recorded - and an
    // empty map means "explicitly set every slot to air", which was
    // ACTIVELY STRIPPING a skeleton's/pillager's own natural default
    // weapon the instant it spawned, regardless of how correct the
    // capture-side reading logic was, since "no data" and "confirmed
    // empty hands" were being treated as the same thing. They are not -
    // "no data" should mean "don't touch what's already there", matching
    // ReplayCraft's own proven-correct philosophy of leaving natural
    // vanilla defaults alone. Equipment is now ONLY actively applied when
    // there is at least one genuinely non-empty recorded slot (a real
    // captured item, e.g. armor looted mid-recording, or a weapon
    // deliberately swapped) - a fully empty snapshot now does nothing at
    // all, leaving whatever the entity naturally spawned with intact.
    const mobEquipmentEntries = playbackState.mobEquipmentEntries.get(mobId);
    const equipmentIndex = mobEquipmentEntries && mobEquipmentEntries.length > 0
        ? Math.max(0, Math.min(
            mobEquipmentEntries.length - 1,
            playbackState.mobEquipmentCursor.get(mobId) ?? 0
        ))
        : -1;
    const equipmentEntry = equipmentIndex >= 0 ? mobEquipmentEntries[equipmentIndex] : undefined;
    const equipmentToApply = equipmentEntry?.equipment;
    const hasRealEquipmentData = equipmentToApply && Object.values(equipmentToApply).some((v) => v);
    if (hasRealEquipmentData) {
        system.run(() => {
            if (!entity || !entity.isValid) return;
            const applied = updateMobActorEquipment(entity, equipmentToApply, undefined);
            playbackState.mobLastAppliedEquipment.set(mobId, applied);
        });
    }
}



function applyCurrentFrame() {
    for (const [playerId, entity] of playbackState.actorEntities.entries()) {
        if (!entity || !entity.isValid) continue;
        const entries = playbackState.actorEntries.get(playerId);
        const cursor = playbackState.actorCursor.get(playerId);
        applyEntry(entity, entries[cursor]);

        // Equipment: a seek is a deliberate jump, same as position above -
        // snap straight to whatever was recorded as equipped at the new
        // cursor, bypassing updateActorEquipment's "only re-set changed
        // slots" optimization (via `undefined` as previousEquipment) so a
        // seek backward past an equipment change correctly reverts every
        // slot, not just the ones that happen to differ from wherever
        // playback was paused.
        const equipmentEntries = playbackState.actorEquipmentEntries.get(playerId);
        if (equipmentEntries && equipmentEntries.length > 0) {
            const equipmentCursor = playbackState.actorEquipmentCursor.get(playerId) ?? 0;
            const applied = updateActorEquipment(entity, equipmentEntries[equipmentCursor].equipment, undefined);
            playbackState.actorLastAppliedEquipment.set(playerId, applied);
        }
    }

    // Mobs (Record & Replay Mobs pass, extended by the Mob Equipment Sync
    // pass): same immediate-reapply idea as the player loop above, over
    // the parallel mob* Maps - a seek/restart must snap mob puppets (and
    // their equipment) to the target tick too, not just players.
    for (const [mobId, entity] of playbackState.mobEntities.entries()) {
        if (entity === undefined || entity === null) continue;
        let entityValid = false;
        try {
            entityValid = entity.isValid === true;
        } catch (e) {
            entityValid = false;
        }
        if (!entityValid) continue;
        const entries = playbackState.mobEntries.get(mobId);
        const cursor = playbackState.mobCursor.get(mobId);
        applyMobEntry(entity, entries[cursor]);
        applyMobStatusAtTick(entity, mobId, playbackState.currentTick);

        // Same "bypass the skip-if-unchanged optimization on a seek"
        // reasoning as the player equipment block above - a seek backward
        // past an equipment change must revert every slot, not just the
        // ones differing from wherever playback was paused.
        const mobEquipmentEntries = playbackState.mobEquipmentEntries.get(mobId);
        if (mobEquipmentEntries && mobEquipmentEntries.length > 0) {
            const equipmentCursor = playbackState.mobEquipmentCursor.get(mobId) ?? 0;
            const applied = updateMobActorEquipment(entity, mobEquipmentEntries[equipmentCursor].equipment, undefined);
            playbackState.mobLastAppliedEquipment.set(mobId, applied);
        }
    }
}

function lerp(a, b, t) {
    return a + (b - a) * t;
}

/** First entry index whose range covers `tick` - entries partition every tick with no gaps, so binary search by endTick is exact. */
function findEntryIndexForTick(entries, tick) {
    let lo = 0;
    let hi = entries.length - 1;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (entries[mid].endTick < tick) {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    return lo;
}

export function pausePlayback() {
    if (!playbackState.active || playbackState.paused) return false;
    if (playbackState.intervalId !== undefined) {
        system.clearRun(playbackState.intervalId);
        playbackState.intervalId = undefined;
    }
    playbackState.paused = true;
    return true;
}

export function resumePlayback() {
    if (!playbackState.active || !playbackState.paused) return false;
    playbackState.paused = false;
    playbackState.tickAccumulator = 0;
    // playheadTick is left as-is (it already sits at playbackState.currentTick's
    // position from the pause) so resuming continues smoothly from exactly
    // where playback paused, instead of snapping.
    playbackState.intervalId = system.runInterval(() => tickPlayback(), 1);
    return true;
}

export function restartPlayback() {
    if (!playbackState.active) return false;
    return seekTo(0);
}

/**
 * Jumps to an arbitrary tick (forward or backward) and applies it immediately.
 * @param {number} tick
 */
export function seekTo(tick) {
    if (!playbackState.active) return false;

    const clamped = Math.max(0, Math.min(playbackState.totalTicks, Math.round(tick)));
    playbackState.currentTick = clamped;
    playbackState.tickAccumulator = 0;
    playbackState.playheadTick = clamped;

    // World Restore Logic polish: a scrub landing at/past the end marks
    // reachedEndViaSeek so tickPlayback's next tick knows the playhead is
    // sitting there because of a manual seek, not genuine forward
    // playback - see this flag's own doc comment on playbackState above.
    // A scrub landing anywhere before the end clears it, since the
    // playhead is no longer sitting at the boundary either way.
    playbackState.reachedEndViaSeek = clamped >= playbackState.totalTicks;

    // A seek to 0 has no prior entry - lookups are 1-indexed by tick, so
    // treat tick 0 the same as tick 1 (first frame) for cursor purposes.
    const lookupTick = Math.max(1, clamped);

    for (const [playerId, entries] of playbackState.actorEntries.entries()) {
        const idx = findEntryIndexForTick(entries, lookupTick);
        playbackState.actorCursor.set(playerId, idx);
        playbackState.actorWasFalling.set(playerId, !!entries[idx].state.falling);
    }

    // Equipment cursor: same binary-search repositioning as position above,
    // over its own separate entry list - a seek (forward OR backward) has
    // to land on whichever equipment was actually recorded as being worn/
    // held at the target tick, not just leave whatever was equipped before
    // the seek. This is what keeps armor/held items correct across Timeline
    // Scrubbing, Restart, and Preview Path's own rewind-to-first-keyframe
    // seek, exactly like position already was.
    for (const [playerId, entries] of playbackState.actorEquipmentEntries.entries()) {
        if (!entries || entries.length === 0) continue;
        const idx = findEntryIndexForTick(entries, lookupTick);
        playbackState.actorEquipmentCursor.set(playerId, idx);
    }

    // Mob cursors (Record & Replay Mobs pass): same binary-search
    // repositioning as position above, over the parallel mob* Maps - a
    // seek (forward or backward) has to land mob puppets on the correct
    // recorded frame for the target tick too, exactly like players.
    for (const [mobId, entries] of playbackState.mobEntries.entries()) {
        if (!entries || entries.length === 0) continue;
        const idx = findEntryIndexForTick(entries, lookupTick);
        playbackState.mobCursor.set(mobId, idx);
    }

    // Mob equipment cursor (Mob Equipment Sync pass): same binary-search
    // repositioning as mob position above, over its own separate entry
    // list - same reasoning as the player equipment cursor block above,
    // just for mob puppets.
    for (const [mobId, entries] of playbackState.mobEquipmentEntries.entries()) {
        if (!entries || entries.length === 0) continue;
        const idx = findEntryIndexForTick(entries, lookupTick);
        playbackState.mobEquipmentCursor.set(mobId, idx);
    }

    // Health-delta fallback must not interpret a manual seek as a real damage event.
    playbackState.actorLastAppliedHealth.clear();
    playbackState.mobLastAppliedHealth.clear();
    applyCurrentFrame();
    seekEventPlayback(clamped);
    seekWorldReplay(clamped);
    return true;
}

/**
 * @param {number} deltaTicks - positive to skip forward, negative to skip back
 */
export function skip(deltaTicks) {
    if (!playbackState.active) return false;
    return seekTo(playbackState.currentTick + deltaTicks);
}

/**
 * @param {number} multiplier - one of SPEED_OPTIONS, but any positive number works
 */
export function setSpeed(multiplier) {
    if (!playbackState.active) return false;
    playbackState.speed = Math.max(0.01, multiplier);
    return true;
}

/**
 * @returns {boolean} whether a playback was actually stopped
 */
export function stopPlayback() {
    if (!playbackState.active) return false;

    if (playbackState.intervalId !== undefined) {
        system.clearRun(playbackState.intervalId);
    }

    endEventPlayback();
    endWorldReplay();

    // Always release Replay Spawn Isolation before returning to normal world
    // simulation, including manual stops and natural replay completion.
    disableReplaySpawnIsolation();

    for (const entity of playbackState.actorEntities.values()) {
        removeActor(entity);
    }

    // Mob puppets (Record & Replay Mobs pass): same cleanup as player
    // actors above, over the parallel mob entity set - a mob puppet must
    // never outlive its playback session, exactly like a player actor.
    for (const entity of playbackState.mobEntities.values()) {
        removeMobActor(entity);
    }
    playbackState.actorLastAppliedHealth.clear();
    playbackState.mobLastAppliedHealth.clear();

    // World Restore Logic: deliberately does NOT restore anything here, on
    // ANY stop (manual or natural end) - the user's own explicit
    // requirement is that world restore happens ONLY when a replay STARTS
    // playing (see playReplay()'s own restoreDeferredSnapshot() call,
    // still there, unchanged, and still the only place a restore happens
    // in the entire playback lifecycle). A replay ending - by any means -
    // never touches the world; whatever was built/changed while it played
    // stays exactly as it is. A prior version of this file restored here
    // at stop time too (gated by the "Restore World On Stop" setting and
    // whether the end was natural or manual) - that was based on an
    // earlier, more complicated spec and is no longer correct; this
    // simpler rule supersedes it.
    if (playbackState.director) {
        // If the director was editing Manual Camera while this replay was
        // running, first restore the Replay Playback sticks that Manual
        // Camera temporarily replaced. Viewing-mode cleanup can then restore
        // the director's original inventory exactly as before.
        try { stopPathVisualization(playbackState.director); } catch (e) {}
        try { exitManualStickMode(playbackState.director); } catch (e) {}
        exitViewingMode(playbackState.director);
    }

    playbackState.active = false;
    playbackState.paused = false;
    playbackState.replayId = undefined;
    playbackState.intervalId = undefined;
    playbackState.currentTick = 0;
    playbackState.totalTicks = 0;
    playbackState.speed = 1;
    playbackState.tickAccumulator = 0;
    playbackState.playheadTick = 0;
    playbackState.reachedEndViaSeek = false;
    playbackState.actorEntities = new Map();
    playbackState.actorEntries = new Map();
    playbackState.actorCursor = new Map();
    playbackState.actorWasFalling = new Map();
    playbackState.actorEquipmentEntries = new Map();
    playbackState.actorEquipmentCursor = new Map();
    playbackState.actorLastAppliedEquipment = new Map();
    playbackState.mobEntities = new Map();
    playbackState.mobDespawnTick = new Map();
    playbackState.mobDespawnReason = new Map();
    playbackState.mobSpawnTick = new Map();
    playbackState.mobRespawnNextAttemptTick = new Map();
    playbackState.mobRecordsById = new Map();
    playbackState.mobAshTagIndex = new Map();
    playbackState.mobLastRenderedState = new Map();
    playbackState.dimension = undefined;
    playbackState.mobEntries = new Map();
    playbackState.mobCursor = new Map();
    playbackState.mobEquipmentEntries = new Map();
    playbackState.mobEquipmentCursor = new Map();
    playbackState.mobLastAppliedEquipment = new Map();
    playbackState.director = undefined;

    return true;
}
