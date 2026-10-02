/**
 * Replay Director - Recording State (Phase 3A)
 *
 * In-memory only for now - Phase 3B adds actual saving to a Replay List.
 * This phase exists to prove the capture + compression pipeline works and
 * stays a reasonable size before we build persistence on top of it.
 */

export const recordingState = {
    active: false,
    startedBy: undefined, // player.id of whoever pressed Start Recording
    recordingDimensionId: undefined, // dimension id where the recording started
    recordingBounds: undefined, // fixed capture scope matching the world snapshot region
    intervalId: undefined,
    tick: 0,
    /**
     * The replay id this session will save under, generated at recording
     * START time (not stop time, like it used to be) - needed up front so
     * the world snapshot's structure can be named after it right away
     * (see snapshot.js's beginSnapshot), keeping the structure name and
     * the eventual saved replay's id in permanent sync. saveReplayFromRecording
     * reuses this id rather than generating a fresh one.
     */
    pendingReplayId: undefined,
    /** @type {Map<string, Array<object>>} playerId -> encoded frame entries */
    buffer: new Map(),
    /** @type {Map<string, object>} playerId -> last captured raw state, for delta comparison */
    lastState: new Map(),
    /**
     * @type {Map<string, Array<{startTick:number, endTick:number, equipment:object}>>}
     * playerId -> encoded equipment entries (Armor & Held Item Replay pass).
     * Deliberately a SEPARATE run-length-encoded buffer from `buffer` above,
     * not folded into each position entry's `state` - armor/held items
     * change far less often than position/rotation, so giving equipment
     * its own independent compression timeline (new entry only when
     * equipment actually changes) keeps both buffers small, instead of
     * armor changes fragmenting the position buffer's compression (or
     * position noise fragmenting an armor timeline) by being forced to
     * share one entry list with a totally different change frequency.
     */
    equipmentBuffer: new Map(),
    /** @type {Map<string, object>} playerId -> last captured raw equipment snapshot, for delta comparison */
    lastEquipment: new Map(),
    /** @type {Map<string, string>} playerId -> player name, captured at record time in case they leave */
    playerNames: new Map(),

    /**
     * Mob capture (Record & Replay Mobs pass) - mirrors the player buffer
     * above exactly, but keyed by the mob's entity.id (a real, stable
     * Script API identifier for the lifetime of a loaded entity - confirmed
     * sufficient for a single recording session, which is the only scope
     * this needs since frame data itself is already session-only).
     * Deliberately a separate Map from `buffer`, same reasoning as
     * equipmentBuffer being separate from buffer: mobs are a completely
     * different population from players (can spawn/die mid-recording,
     * don't have a stable cross-session id, may never speak/equip), so
     * giving them their own buffer avoids conflating two populations with
     * different lifecycles into one Map keyed by a shared id space.
     * @type {Map<string, Array<object>>} entity.id -> encoded frame entries
     */
    mobBuffer: new Map(),
    /** @type {Map<string, object>} entity.id -> last captured raw mob state, for delta comparison */
    mobLastState: new Map(),
    /** @type {Map<string, string>} entity.id -> typeId (e.g. "minecraft:zombie"), captured at first sight in case the mob dies before recording stops */
    mobTypeIds: new Map(),
    /** @type {Set<string>} entity.id of mobs seen at least once this recording - lets capture.js detect "first tick seen" vs "still here" without a separate lookup */
    mobSeen: new Set(),
    /**
     * @type {Map<string, number>} entity.id -> recordingState.tick at which
     * this mob died or was removed during the recording (Generic Ambient
     * Mob Capture pass, despawn tracking). Set by capture.js's own
     * entityDie/entityRemove subscriptions (recording-scoped, separate
     * from events.js's now mob-family-excluded mob_spawn/mob_death event
     * stream - see that file's updated header). Absent/undefined means
     * the mob was still alive when recording stopped, so it should stay
     * visible for the entire replay.
     */
    mobDespawnTick: new Map(),
    mobDespawnReason: new Map(),
    mobMissingTicks: new Map(),
    /** @type {Map<string, boolean>} entity.id -> whether this mob was a baby (EntityIsBabyComponent presence) the first tick it was seen - captured once at first sight, not tracked continuously, since aging up mid-recording is rare and not v1 scope */
    mobIsBaby: new Map(),
    /** @type {Map<string, boolean>} entity.id -> whether this mob was tamed as of the last capture tick (Taming Particles pass) - compared tick-to-tick to detect the exact moment it flips false->true */
    mobWasTamed: new Map(),
    /** @type {Map<string, boolean>} entity.id -> whether this mob was on fire as of the last capture tick (Burning Particles pass) - compared tick-to-tick to detect both catching fire and being extinguished */
    mobWasBurning: new Map(),
    /** @type {Map<string, string>} entity.id -> the villager's last known profession family name, or "none" (Villager Profession Replay pass v2) - compared tick-to-tick to detect real profession changes via direct type_family reads */
    mobLastProfession: new Map(),
    /** @type {Map<string, string|undefined>} player.id -> the tradeable item typeId they were last seen gesturing with near a villager/trader (Trade Gesture Replay pass), or undefined - used to detect the START of a gesture, not re-fire every tick they keep holding the same item near the same trader */
    lastTradeGestureItem: new Map(),

    /**
     * Mob equipment capture (Mob Equipment Sync pass) - same
     * separate-RLE-stream reasoning as the player equipmentBuffer above,
     * over mobs instead of players. Not every mob has anything to capture
     * here (a cow has no minecraft:equippable component at all - see
     * capture.js's buildMobEquipmentSnapshot, which returns an all-empty
     * snapshot for such mobs, never a forced/fabricated one), so this Map
     * may simply stay empty for equipment-incapable mob types - that's
     * correct, not a gap.
     * @type {Map<string, Array<{startTick:number, endTick:number, equipment:object}>>} entity.id -> encoded equipment entries
     */
    mobEquipmentBuffer: new Map(),
    /** @type {Map<string, object>} entity.id -> last captured raw mob equipment snapshot, for delta comparison */
    mobLastEquipment: new Map(),

    /**
     * Mob status capture (Ambient Status Effects pass) - same
     * separate-RLE-stream reasoning as mobEquipmentBuffer above, tracking
     * discrete boolean-ish state (onFire, isTamed) that shouldn't be
     * blended/interpolated the way position is - see capture.js's
     * buildMobStatusSnapshot. A transition FROM false TO true in either
     * field, at a specific tick, is exactly the moment playback.js needs
     * to recreate (catching fire / being tamed), so this stream doubles
     * as both "what state to hold" AND "when did it last change" without
     * needing a third, separate discrete-event stream.
     * @type {Map<string, Array<{startTick:number, endTick:number, status:{onFire:boolean, isTamed:boolean}}>>}
     */
    mobStatusBuffer: new Map(),
    /** @type {Map<string, object>} entity.id -> last captured raw mob status snapshot, for delta comparison */
    mobLastStatus: new Map()
};

export function resetRecordingState() {
    recordingState.active = false;
    recordingState.startedBy = undefined;
    recordingState.recordingDimensionId = undefined;
    recordingState.recordingBounds = undefined;
    recordingState.intervalId = undefined;
    recordingState.tick = 0;
    recordingState.pendingReplayId = undefined;
    recordingState.buffer = new Map();
    recordingState.lastState = new Map();
    recordingState.equipmentBuffer = new Map();
    recordingState.lastEquipment = new Map();
    recordingState.playerNames = new Map();
    recordingState.mobBuffer = new Map();
    recordingState.mobLastState = new Map();
    recordingState.mobTypeIds = new Map();
    recordingState.mobSeen = new Set();
    recordingState.mobDespawnTick = new Map();
    recordingState.mobDespawnReason = new Map();
    recordingState.mobMissingTicks = new Map();
    recordingState.mobIsBaby = new Map();
    recordingState.mobWasTamed = new Map();
    recordingState.mobWasBurning = new Map();
    recordingState.mobLastProfession = new Map();
    recordingState.lastTradeGestureItem = new Map();
    recordingState.mobEquipmentBuffer = new Map();
    recordingState.mobLastEquipment = new Map();
    recordingState.mobStatusBuffer = new Map();
    recordingState.mobLastStatus = new Map();
}
