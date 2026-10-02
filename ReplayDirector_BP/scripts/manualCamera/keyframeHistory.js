/**
 * Replay Director - Keyframe Undo/Redo (Undo/Redo pass)
 *
 * A per-director-per-replay undo/redo stack over Manual Camera Mode's
 * keyframe paths (pathState.js). Deliberately whole-snapshot based, not
 * inverse-operation based: every mutation in pathState.js (addKeyframe,
 * removeKeyframe, updateKeyframeLocation, updateKeyframeTiming,
 * moveKeyframe) has a different shape, and hand-writing a correct inverse
 * for each (especially updateKeyframeLocation/Timing, which overwrite
 * fields in place rather than appending/removing) is exactly the kind of
 * thing that's easy to get subtly wrong in one case and silently corrupt
 * a keyframe on undo. Instead, this captures a full deep copy of the
 * keyframes array immediately BEFORE each mutating call, and undo/redo
 * simply swap the whole array back and forth - correct by construction
 * for every mutation type, at the cost of copying a typically-small array
 * (keyframe counts are naturally low - a handful to a few dozen per
 * shot, not thousands) rather than any real scalability concern.
 *
 * Scope (explicit, per the user's own choice): KEYFRAMES ONLY - not
 * replay actor edits (armor/name/nametag), not timeline playback state
 * (seek/speed/pause), which are live playback state, not persistent
 * edits. pathState.js's own functions are untouched by this file - every
 * UI call site that mutates a path now also calls pushUndoSnapshot()
 * immediately before the mutation, and undo()/redo() below call back into
 * pathState.js's own (also untouched) internal path storage via a single
 * new accessor, replacePath(), added to pathState.js for exactly this
 * purpose.
 *
 * Session-only, same as every other editing-session state in this addon
 * (pathState.js itself, playbackState in playback.js) - a fresh session
 * starts with an empty undo history, and switching replays/directors
 * switches to that pair's own independent history (same composite-key
 * pattern pathState.js already uses).
 */

const MAX_HISTORY_DEPTH = 30;

function historyKey(playerId, replayId) {
    return `${playerId}::${replayId}`;
}

/** @type {Map<string, {undoStack: Array<Array<object>>, redoStack: Array<Array<object>>}>} */
const histories = new Map();

function getHistory(playerId, replayId) {
    const key = historyKey(playerId, replayId);
    let history = histories.get(key);
    if (!history) {
        history = { undoStack: [], redoStack: [] };
        histories.set(key, history);
    }
    return history;
}

/**
 * Call immediately BEFORE any pathState.js mutation (addKeyframe,
 * removeKeyframe, updateKeyframeLocation, updateKeyframeTiming,
 * moveKeyframe) - captures the keyframes array as it exists at THIS
 * moment, so undo() can restore exactly this state. Also clears the redo
 * stack, same as any conventional editor: making a new edit after an
 * undo abandons the "future" that redo would have replayed, since that
 * future no longer matches what's about to happen.
 * @param {string} playerId
 * @param {string} replayId
 * @param {Array<object>} currentKeyframes - the path's keyframes array as it exists right now, before the caller's mutation runs
 */
export function pushUndoSnapshot(playerId, replayId, currentKeyframes) {
    const history = getHistory(playerId, replayId);
    history.undoStack.push(deepCopyKeyframes(currentKeyframes));
    if (history.undoStack.length > MAX_HISTORY_DEPTH) {
        history.undoStack.shift();
    }
    history.redoStack = [];
}

/**
 * @param {string} playerId
 * @param {string} replayId
 * @param {Array<object>} currentKeyframes - the path's keyframes array as it exists right now, needed so redo() can restore back to this exact state later
 * @returns {Array<object>|undefined} the keyframes array to restore, or undefined if there's nothing to undo
 */
export function undo(playerId, replayId, currentKeyframes) {
    const history = getHistory(playerId, replayId);
    const previous = history.undoStack.pop();
    if (!previous) return undefined;
    history.redoStack.push(deepCopyKeyframes(currentKeyframes));
    return previous;
}

/**
 * @param {string} playerId
 * @param {string} replayId
 * @param {Array<object>} currentKeyframes - the path's keyframes array as it exists right now, needed so a later undo can restore back to this exact state
 * @returns {Array<object>|undefined} the keyframes array to restore, or undefined if there's nothing to redo
 */
export function redo(playerId, replayId, currentKeyframes) {
    const history = getHistory(playerId, replayId);
    const next = history.redoStack.pop();
    if (!next) return undefined;
    history.undoStack.push(deepCopyKeyframes(currentKeyframes));
    return next;
}

/** @returns {boolean} whether an undo is currently available for this director+replay */
export function canUndo(playerId, replayId) {
    return getHistory(playerId, replayId).undoStack.length > 0;
}

/** @returns {boolean} whether a redo is currently available for this director+replay */
export function canRedo(playerId, replayId) {
    return getHistory(playerId, replayId).redoStack.length > 0;
}

/**
 * Clears undo/redo history for a director+replay pair - called from the
 * same places pathState.js's own clearPath()/clearPathsForReplay() are
 * called (starting a brand new path, or the replay being deleted
 * entirely), so stale history never resurrects keyframes that no longer
 * have any path to belong to.
 */
export function clearHistory(playerId, replayId) {
    histories.delete(historyKey(playerId, replayId));
}

/**
 * Same idea as pathState.js's own clearPathsForReplay - removes every
 * director's undo history for a given replay (all playerId keys that
 * reference it), called when that replay is deleted.
 * @param {string} replayId
 */
export function clearHistoryForReplay(replayId) {
    const suffix = `::${replayId}`;
    for (const key of [...histories.keys()]) {
        if (key.endsWith(suffix)) histories.delete(key);
    }
}

function deepCopyKeyframes(keyframes) {
    return keyframes.map((k) => ({
        ...k,
        location: { ...k.location },
        rotation: { ...k.rotation },
        armorSnapshot: k.armorSnapshot ? JSON.parse(JSON.stringify(k.armorSnapshot)) : undefined,
        // Custom Camera Path: pathTarget/pathPoints are nested
        // objects/arrays too - same reasoning as armorSnapshot above, a
        // shallow {...k} would leave every snapshot sharing the SAME
        // pathPoints array reference, so editing points after an undo
        // would silently corrupt earlier history entries.
        pathTarget: k.pathTarget ? JSON.parse(JSON.stringify(k.pathTarget)) : null,
        pathPoints: (k.pathPoints || []).map((p) => ({ ...p }))
    }));
}
