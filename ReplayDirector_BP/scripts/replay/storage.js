/**
 * Replay Director - Replay Storage (Phase 3B, equipment persistence added
 * in the Armor & Held Item Replay pass)
 *
 * Persists replay METADATA (name, date, stats, and one "actor" entry per
 * recorded player - each with its own skin/name/armor/held item/visibility
 * settings) via world dynamic properties. This is small data and comfortably
 * fits the size limits.
 *
 * The actual recorded frame buffer (positions/rotations/events over time,
 * AND now armor/held-item equipment - see equipmentFrameStore below) is NOT
 * persisted to dynamic properties yet - it stays in the in-memory
 * frameStore/equipmentFrameStore for the current game session only, exactly
 * the same scope position data has always had. Persisting that (compressed,
 * chunked across many dynamic property keys per the roadmap) is its own
 * storage-engine step that has to happen before a replay can be read back
 * after a restart - that's a pre-existing limitation of the whole replay
 * engine, not something new to equipment, and out of scope for this pass
 * (which only adds armor/held-item capture and playback on top of the
 * existing session-scoped frame pipeline, without redesigning it).
 */

import { world } from "@minecraft/server";
import { recordingState } from "./recordingState.js";
import { getDefaultSkinId } from "../core/replaySkins.js";
import { deleteDeferredSnapshotStructure } from "./snapshot.js";
import { getMobDisplayName, isReplayProjectileType } from "./mobSupport.js";
import { persistFrameData, loadPersistedFrameData, deletePersistedFrameData, hasPersistedFrameData } from "./framePersistence.js";

const LIST_KEY = "replay:list";
const NEXT_INDEX_KEY = "replay:next_index";
const META_PREFIX = "replay:meta:";

// Phase 3I: a soft cap on saved replays so a forgotten habit of recording
// everything doesn't quietly grow the metadata store forever - oldest gets
// pruned automatically when a new save would exceed this.
export const MAX_SAVED_REPLAYS = 20;

/** @type {Map<string, Map<string, Array<object>>>} replayId -> (playerId -> frame entries), in-memory only */
const frameStore = new Map();

/** @type {Map<string, Map<string, Array<object>>>} replayId -> (playerId -> equipment entries), in-memory only - same session-only caveat as frameStore, kept as its own parallel map for the same reason recordingState keeps a separate equipmentBuffer (see capture.js/recordingState.js) */
const equipmentFrameStore = new Map();

/** @type {Map<string, Map<string, Array<object>>>} replayId -> (mobEntityId -> frame entries), in-memory only - same session-only caveat as frameStore/equipmentFrameStore (Record & Replay Mobs pass) */
const mobFrameStore = new Map();

/** @type {Map<string, Map<string, Array<object>>>} replayId -> (mobEntityId -> equipment entries), in-memory only - same session-only caveat as equipmentFrameStore (Mob Equipment Sync pass) */
const mobEquipmentFrameStore = new Map();
/** @type {Map<string, Map<string, Array<object>>>} replayId -> (mobEntityId -> status entries) */
const mobStatusFrameStore = new Map();

/** @type {Map<string, Array<object>>} replayId -> world event list (Phase 3F), in-memory only - same session-only caveat as frameStore */
const eventStore = new Map();

function getIdList() {
    const raw = world.getDynamicProperty(LIST_KEY);
    if (typeof raw !== "string") return [];
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
        return [];
    }
}

function setIdList(ids) {
    world.setDynamicProperty(LIST_KEY, JSON.stringify(ids));
}

function nextIndex() {
    const current = world.getDynamicProperty(NEXT_INDEX_KEY);
    const n = typeof current === "number" ? current + 1 : 1;
    world.setDynamicProperty(NEXT_INDEX_KEY, n);
    return n;
}

function metaKey(id) {
    return `${META_PREFIX}${id}`;
}

function readMeta(id) {
    const raw = world.getDynamicProperty(metaKey(id));
    if (typeof raw !== "string") return undefined;
    try {
        return JSON.parse(raw);
    } catch (e) {
        return undefined;
    }
}

function writeMeta(record) {
    world.setDynamicProperty(metaKey(record.id), JSON.stringify(record));
}

/**
 * Generates a fresh replay id, without saving anything yet. Called at
 * recording-START time now (not stop time, like it used to be) so the
 * world snapshot's structure can be named after this id right away (see
 * snapshot.js's beginSnapshot + capture.js's startRecording) - the id is
 * then threaded through to saveReplayFromRecording below, which reuses it
 * rather than generating a second, different one.
 */
export function allocateReplayId() {
    const index = nextIndex();
    return { id: `replay_${Date.now()}_${index}`, index };
}

/**
 * Builds and persists a replay record from the just-finished recording
 * session in recordingState, plus its stats.
 * @param {{frameCount:number, playerCount:number, entryCount:number, approxBytes:number}} stats
 * @param {{id:string, index:number}} allocated - from allocateReplayId(), called back at recording-start time so the id matches the snapshot structure's name
 * @param {{structureId:string, from:object, to:object, dimensionId:string, blocksSnapshotted:boolean}} [deferredSnapshot] - see snapshot.js's restoreSnapshot(). Stored on the record so playback.js can restore it right before this replay's actors spawn, whenever it's actually played.
 * @returns {object} the saved replay record
 */
export function saveReplayFromRecording(stats, allocated, deferredSnapshot) {
    const { id, index } = allocated;
    const name = `Replay ${index}`;

    const actors = [];
    for (const [playerId, name_] of recordingState.playerNames.entries()) {
        actors.push({
            playerId,
            playerName: name_,
            displayName: name_,
            nameColor: undefined, // undefined = default white, otherwise a "§" color code like "§c"
            nameTagVisible: true,
            skinId: getDefaultSkinId(),
            armor: undefined, // reserved for a future per-actor display override (e.g. force a fixed armor set) - separate from the actually-recorded per-tick equipment below, same as skinId is separate from recorded appearance
            heldItem: undefined, // reserved for a future per-actor display override, same caveat as armor above
            visible: true,
        });
    }

    // Mob actors (Record & Replay Mobs pass) - one entry per distinct mob
    // seen during this recording (recordingState.mobSeen), each carrying
    // its real vanilla typeId so playback.js/mobActors.js know which
    // puppet entity type to spawn (see mobSupport.js - only ever a
    // supported typeId, since captureMobsTick already filtered by the
    // allowlist before anything was ever added to mobSeen/mobTypeIds).
    // Deliberately NOT reusing the player actors[] array/shape - a mob
    // actor has no skinId/armor/heldItem/nameColor concepts (those are
    // player-shaped, per the feature request's own explicit caution not
    // to reuse that system for mobs by default), just an identity +
    // display visibility toggle.
    const mobs = [];
    const projectiles = [];
    for (const mobId of recordingState.mobSeen) {
        const typeId = recordingState.mobTypeIds.get(mobId);
        if (!typeId) continue;
        const common = {
            mobId,
            typeId,
            displayName: getMobDisplayName(typeId),
            visible: true,
            despawnTick: recordingState.mobDespawnTick.has(mobId) ? recordingState.mobDespawnTick.get(mobId) : null,
            despawnReason: recordingState.mobDespawnReason.get(mobId) || null
        };
        if (isReplayProjectileType(typeId)) {
            projectiles.push(common);
        } else {
            mobs.push({
                ...common,
                isBaby: recordingState.mobIsBaby.get(mobId) === true
            });
        }
    }

    const record = {
        id,
        name,
        createdAt: Date.now(),
        frameCount: stats.frameCount,
        playerCount: stats.playerCount,
        entryCount: stats.entryCount,
        approxBytes: stats.approxBytes,
        actors,
        // Mob-specific fields (Record & Replay Mobs pass) - additive,
        // existing readers of this record that don't know about mobs yet
        // (older UI screens, older saved-replay records without these
        // fields at all) simply don't see them; mobs defaults to an empty
        // array rather than undefined so playback.js can iterate it
        // unconditionally without an extra existence check.
        mobs,
        projectiles,
        projectileCount: projectiles.length,
        mobCount: stats.mobCount || 0,
        // Recording scope metadata is additive and preserves the existing replay
        // format fields. It documents the dimension and bounded event/mob scope
        // used by the corrected recorder without changing actor/frame storage.
        recordingDimensionId: recordingState.recordingDimensionId,
        recordingBounds: recordingState.recordingBounds
            ? {
                dimensionId: recordingState.recordingBounds.dimensionId,
                from: { ...recordingState.recordingBounds.from },
                to: { ...recordingState.recordingBounds.to }
            }
            : undefined,
        deferredSnapshot: deferredSnapshot || undefined
    };

    writeMeta(record);
    const ids = getIdList();
    ids.push(id);
    setIdList(ids);

    // Frame data stays in memory only, keyed by replay id, for this session.
    frameStore.set(id, new Map(recordingState.buffer));
    equipmentFrameStore.set(id, new Map(recordingState.equipmentBuffer));
    mobFrameStore.set(id, new Map(recordingState.mobBuffer));
    mobEquipmentFrameStore.set(id, new Map(recordingState.mobEquipmentBuffer));
mobStatusFrameStore.set(id, new Map(recordingState.mobStatusBuffer));

    // No auto-pruning here - a saved replay is never deleted except by the
    // user explicitly choosing Delete in Replay Detail. MAX_SAVED_REPLAYS
    // is still exposed (see isOverSavedReplayCap below) so the UI can warn
    // when the list is getting long, without ever deleting anything itself.
    const atOrOverCap = getIdList().length > MAX_SAVED_REPLAYS;

    return { record, atOrOverCap };
}

/** @returns {boolean} true if the saved replay list is at or past MAX_SAVED_REPLAYS - informational only, nothing gets auto-deleted because of this. */
export function isOverSavedReplayCap() {
    return getIdList().length > MAX_SAVED_REPLAYS;
}

/** @returns {number} total bytes currently used by this addon's world dynamic properties (metadata only - frame/event data isn't persisted here) */
export function getStorageUsageBytes() {
    try {
        return world.getDynamicPropertyTotalByteCount();
    } catch (e) {
        return 0;
    }
}

export function listReplays() {
    return getIdList()
        .map((id) => readMeta(id))
        .filter((r) => !!r)
        .sort((a, b) => b.createdAt - a.createdAt);
}

export function getReplay(id) {
    return readMeta(id);
}

/**
 * @param {string} id
 * @returns {Map<string, Array<object>>|undefined} playerId -> frame entries, or undefined if not in memory this session
 */
export function getFrameData(id) {
    return frameStore.get(id);
}

/**
 * Persistent Recordings pass: if this replay's in-memory frame stores are
 * empty (the normal case after a world restart - see framePersistence.js's
 * own header for why in-memory data doesn't survive one), attempts to load
 * its persisted chunked data and populate ALL FIVE in-memory stores
 * (frame/equipment/mob/mobEquipment/events) together, atomically, rather
 * than letting each getter below independently and inconsistently decide
 * whether to hydrate - a replay with SOME stores hydrated and others still
 * empty would silently produce broken/partial playback (e.g. positions
 * with no equipment, or vice versa) in a way that's hard to diagnose.
 * Called once, from playback.js's playReplay(), before any of the
 * individual getters are used for that replayId. A no-op if the in-memory
 * frame store already has this id (this session's own just-recorded
 * replay, or one already hydrated earlier this session) - never re-reads
 * persisted data on top of live in-memory data.
 * @param {string} replayId
 * @returns {boolean} true if data is now available (either already was, or was just hydrated), false if genuinely nothing exists anywhere for this replay
 */
export function ensureFrameDataLoaded(replayId) {
    if (frameStore.has(replayId)) return true;

    const persisted = loadPersistedFrameData(replayId);
    if (!persisted) return false;

    frameStore.set(replayId, persisted.buffer);
    equipmentFrameStore.set(replayId, persisted.equipmentBuffer);
    mobFrameStore.set(replayId, persisted.mobBuffer);
    mobEquipmentFrameStore.set(replayId, persisted.mobEquipmentBuffer);
    mobStatusFrameStore.set(replayId, persisted.mobStatusBuffer || new Map());
    eventStore.set(replayId, persisted.events);

    return true;
}

/** @returns {boolean} whether this replay has persisted frame data available (survives restart) - purely informational, for UI display (e.g. Replay Detail showing a "saved permanently" indicator) */
export function isFrameDataPersisted(replayId) {
    return hasPersistedFrameData(replayId);
}

/**
 * @param {string} id
 * @returns {Map<string, Array<object>>|undefined} playerId -> equipment entries, or undefined if not in memory this session - same session-only caveat as getFrameData
 */
export function getEquipmentFrameData(id) {
    return equipmentFrameStore.get(id);
}

/**
 * @param {string} id
 * @returns {Map<string, Array<object>>|undefined} mobEntityId -> frame entries, or undefined if not in memory this session - same session-only caveat as getFrameData (Record & Replay Mobs pass)
 */
export function getMobFrameData(id) {
    return mobFrameStore.get(id);
}

/**
 * @param {string} id
 * @returns {Map<string, Array<object>>|undefined} mobEntityId -> equipment entries, or undefined if not in memory this session - same session-only caveat as getEquipmentFrameData (Mob Equipment Sync pass)
 */
export function getMobEquipmentFrameData(id) {
    return mobEquipmentFrameStore.get(id);
}

/** @returns {Map<string, Array<object>>|undefined} mobEntityId -> status entries */
export function getMobStatusFrameData(id) {
    return mobStatusFrameStore.get(id);
}

/**
 * Attaches a captured world-event list (Phase 3F) to an already-saved
 * replay, and stashes a small per-type count in its persisted metadata so
 * Replay Detail can show something meaningful even after a restart (the
 * events themselves are session-only, same caveat as frame data).
 * @param {string} replayId
 * @param {Array<{tick:number, type:string, data:object}>} events
 */
export function attachEvents(replayId, events) {
    eventStore.set(replayId, events);

    const record = readMeta(replayId);
    if (!record) return;

    const summary = {};
    for (const event of events) {
        summary[event.type] = (summary[event.type] || 0) + 1;
    }
    record.eventSummary = summary;
    writeMeta(record);
}

/**
 * Persistent Recordings pass: persists a just-saved replay's full frame/
 * equipment/event bundle to chunked dynamic properties, so it survives a
 * world/server restart. Must be called AFTER both
 * saveReplayFromRecording() and attachEvents() for the same replayId -
 * events aren't attached until attachEvents runs, and this needs them
 * included in what gets persisted (see replayMenu.js's call site, which
 * calls this last, right after attachEvents). Calling it before events
 * are attached would silently persist an empty events list - not
 * dangerous, but that replay's world-event playback (block changes,
 * pulses) would be missing after a restart even though everything else
 * worked, so the ordering matters.
 * @param {string} replayId
 */
export function persistRecordedFrameData(replayId) {
    return persistFrameData(replayId, {
        buffer: frameStore.get(replayId),
        equipmentBuffer: equipmentFrameStore.get(replayId),
        mobBuffer: mobFrameStore.get(replayId),
        mobEquipmentBuffer: mobEquipmentFrameStore.get(replayId),
        mobStatusBuffer: mobStatusFrameStore.get(replayId),
        events: eventStore.get(replayId)
    });
}

/**
 * @param {string} id
 * @returns {Array<object>|undefined} the event list, or undefined if not in memory this session
 */
export function getEventData(id) {
    return eventStore.get(id);
}

export function renameReplay(id, newName) {
    const record = readMeta(id);
    if (!record) return false;
    record.name = newName;
    writeMeta(record);
    return true;
}

export function deleteReplay(id) {
    const record = readMeta(id);
    const ids = getIdList().filter((existingId) => existingId !== id);
    setIdList(ids);
    world.setDynamicProperty(metaKey(id), undefined);
    frameStore.delete(id);
    equipmentFrameStore.delete(id);
    mobFrameStore.delete(id);
    mobEquipmentFrameStore.delete(id);
mobStatusFrameStore.delete(id);
    eventStore.delete(id);

    // Persistent Recordings pass: clean up any chunked dynamic-property
    // data too, so a deleted replay doesn't leave orphaned chunks behind
    // consuming persistence budget forever - safe to call even if this
    // replay was never persisted (framePersistence.js's own no-op guard).
    deletePersistedFrameData(id);

    // A deferred snapshot's structure exists as a real world structure
    // until either it's replaced by a NEWER recording of the same replay
    // id (never happens - ids aren't reused) or the replay itself is
    // deleted - snapshot.js's restoreDeferredSnapshot() deliberately never
    // auto-deletes it (a replay can be played more than once, and each
    // play needs the structure to still be there - see that function's
    // own comment), so cleaning it up here, on delete, is the only place
    // it ever happens.
    if (record && record.deferredSnapshot) {
        deleteDeferredSnapshotStructure(record.deferredSnapshot.structureIds || record.deferredSnapshot.structureId);
    }

    return true;
}

/**
 * Duplicates a replay's metadata + actor settings under a new id. Frame
 * data is copied from whatever's currently in the in-memory stores for
 * the original - ensureFrameDataLoaded() is called first so a replay
 * that was persisted (Persistent Recordings pass) but not yet hydrated
 * into memory this session (e.g. duplicating it as the very first action
 * after a restart, before ever playing it) still duplicates correctly
 * rather than silently copying nothing. The DUPLICATE itself is never
 * separately persisted here - it only exists in memory for this session,
 * same limitation as any other in-memory-only data; persisting it too
 * would need its own explicit save action, which duplication doesn't
 * currently offer.
 */
export function duplicateReplay(id) {
    const original = readMeta(id);
    if (!original) return undefined;

    ensureFrameDataLoaded(id);

    const index = nextIndex();
    const newId = `replay_${Date.now()}_${index}`;
    const copy = {
        ...original,
        id: newId,
        name: `${original.name} (Copy)`,
        createdAt: Date.now(),
        actors: original.actors.map((a) => ({
            ...a,
            armor: a.armor ? { ...a.armor } : a.armor,
        })),
        mobs: (original.mobs || []).map((m) => ({ ...m }))
    };

    writeMeta(copy);
    const ids = getIdList();
    ids.push(newId);
    setIdList(ids);

    const originalFrames = frameStore.get(id);
    if (originalFrames) {
        frameStore.set(newId, new Map(originalFrames));
    }

    const originalEquipmentFrames = equipmentFrameStore.get(id);
    if (originalEquipmentFrames) {
        equipmentFrameStore.set(newId, new Map(originalEquipmentFrames));
    }

    const originalMobFrames = mobFrameStore.get(id);
    if (originalMobFrames) {
        mobFrameStore.set(newId, new Map(originalMobFrames));
    }

    const originalMobEquipmentFrames = mobEquipmentFrameStore.get(id);
    if (originalMobEquipmentFrames) {
        mobEquipmentFrameStore.set(newId, new Map(originalMobEquipmentFrames));
    }

    const originalEvents = eventStore.get(id);
    if (originalEvents) {
        eventStore.set(newId, [...originalEvents]);
    }

    return copy;
}

export function updateActor(replayId, playerId, patch) {
    const record = readMeta(replayId);
    if (!record) return false;
    const actor = record.actors.find((a) => a.playerId === playerId);
    if (!actor) return false;
    Object.assign(actor, patch);
    writeMeta(record);
    return true;
}

/** Same shape as updateActor above, but for a mob entry (matched by mobId, not playerId) - currently only used for the visible toggle (see ui/replayActorMenu.js's mob read-only summary), same reasoning as mobs not sharing the player actors[] array documented in saveReplayFromRecording. */
export function updateMobActor(replayId, mobId, patch) {
    const record = readMeta(replayId);
    if (!record || !record.mobs) return false;
    const mob = record.mobs.find((m) => m.mobId === mobId);
    if (!mob) return false;
    Object.assign(mob, patch);
    writeMeta(record);
    return true;
}
