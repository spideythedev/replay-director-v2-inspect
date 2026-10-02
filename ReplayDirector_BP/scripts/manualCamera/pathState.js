/**
 * Replay Director - Manual Camera Path State (Phase 3H)
 *
 * Replay-scoped Keyframes pass: keyframe paths are now keyed by BOTH the
 * director (playerId) AND the replay they were authored for (replayId),
 * instead of playerId alone. Manual Camera Mode is only ever reachable
 * while a replay is actively playing (Director Controls gates entry via
 * isPlaying()), so replayId always comes from playback.getPlayingReplayId()
 * at the UI layer - this file just stores whatever key it's given.
 *
 * Session-only in-memory storage, same as every other replay data store in
 * this addon (frameStore/eventStore in storage.js) - no persistence change
 * needed here to satisfy "creating a new replay starts with zero keyframes"
 * or "opening Replay A only loads Replay A's keyframes": a fresh composite
 * key naturally has no entry, and switching replays naturally switches keys.
 *
 * Timeline-aware Keyframes pass: a keyframe is now
 * {location, rotation:{yaw,pitch}, timelineTick, holdTicks, easing} -
 * timelineTick is the replay's playback tick at the moment the keyframe was
 * captured (or last re-captured via "Move Camera Here" / "Jump Here"), so a
 * saved keyframe remembers WHEN in the replay it belongs, not just WHERE the
 * camera was. holdTicks/easing still describe the transition INTO that
 * keyframe from the previous one (the first keyframe's holdTicks/easing are
 * unused, since there's nothing before it to transition from).
 */

import { getReplay } from "../replay/storage.js";

const DEFAULT_HOLD_TICKS = 60;
const DEFAULT_EASING = "linear";
const DEFAULT_PATH_TYPE = "straight";
const DEFAULT_CURVE_ENABLED = true;
const DEFAULT_CURVE_MODE = "smooth";

/** Every supported path type, kept here (not just in pathTypes.js) so pathState.js can validate without importing the registry - avoids a circular import (pathTypes.js doesn't need to know about pathState.js's storage shape at all). */
export const VALID_PATH_TYPES = ["straight", "curve", "smooth_curve", "circular", "circular3d", "orbit", "focus"];

/**
 * Builds a {[actorPlayerId]: armorObject} snapshot of every actor's
 * current armor in a replay, for storing on a keyframe at capture time.
 * Reads directly from storage.js's replay record - the same armor data
 * the 8th stick's Armor/Held Item menu writes to - so a keyframe always
 * reflects whatever armor was actually set at that moment, not a guess.
 * @param {string} replayId
 * @returns {object} may be empty if the replay has no actors/armor yet
 */
export function snapshotActorArmor(replayId) {
    const record = getReplay(replayId);
    const snapshot = {};
    if (!record || !record.actors) return snapshot;
    for (const actor of record.actors) {
        if (actor.armor) {
            snapshot[actor.playerId] = JSON.parse(JSON.stringify(actor.armor));
        }
    }
    return snapshot;
}

function pathKey(playerId, replayId) {
    return `${playerId}::${replayId}`;
}

/** @type {Map<string, {keyframes: Array<object>}>} keyed by "playerId::replayId" */
const paths = new Map();

export function getPath(playerId, replayId) {
    const key = pathKey(playerId, replayId);
    let path = paths.get(key);
    if (!path) {
        path = { keyframes: [], curveEnabled: DEFAULT_CURVE_ENABLED };
        paths.set(key, path);
    }
    // Backward-compat: a keyframe created before Custom Camera Path
    // (or restored via undo/redo from before this feature) won't have
    // pathType/pathTarget/pathPoints - normalize in place so every other
    // function in this file, and every caller elsewhere, can rely on
    // these fields always being present rather than checking undefined
    // everywhere. Cheap (a handful of keyframes at most) and idempotent.
    for (const kf of path.keyframes) {
        if (kf.pathType === undefined) kf.pathType = DEFAULT_PATH_TYPE;
        if (kf.pathTarget === undefined) kf.pathTarget = null;
        if (kf.pathPoints === undefined) kf.pathPoints = [];
    }
    if (path.curveEnabled === undefined) path.curveEnabled = DEFAULT_CURVE_ENABLED;
    if (path.curveMode !== "circular" && path.curveMode !== "smooth") path.curveMode = DEFAULT_CURVE_MODE;
    return path;
}

/**
 * @param {string} playerId
 * @param {string} replayId
 * @param {{x:number,y:number,z:number}} location
 * @param {{x:number,y:number}} rotation - Vector2 from Entity.getRotation() (x=pitch, y=yaw)
 * @param {number} timelineTick - the replay's current playback tick at capture time
 * @param {object|undefined} armorSnapshot - {[actorPlayerId]: armorObject} snapshot of every replay actor's current armor at the moment this keyframe was added, so it can be reapplied when the timeline reaches this keyframe. Optional so existing call sites/older behavior aren't forced to supply one.
 * @returns {number} the new keyframe's index
 */
export function addKeyframe(playerId, replayId, location, rotation, timelineTick, armorSnapshot) {
    const path = getPath(playerId, replayId);
    path.keyframes.push({
        location: { ...location },
        rotation: { yaw: rotation.y, pitch: rotation.x },
        timelineTick: Math.max(0, Math.round(timelineTick ?? 0)),
        holdTicks: DEFAULT_HOLD_TICKS,
        easing: DEFAULT_EASING,
        armorSnapshot: armorSnapshot ? JSON.parse(JSON.stringify(armorSnapshot)) : undefined,
        // Custom Camera Path: pathType describes the transition INTO this
        // keyframe (same convention holdTicks/easing already use - the
        // first keyframe's pathType is unused, same as its holdTicks/
        // easing are, since nothing transitions into it). pathTarget is
        // only meaningful for circular/orbit/focus - {mode:"actor",
        // actorPlayerId} or {mode:"point", location:{x,y,z}} - null until
        // the user actually sets one via Set Target. pathPoints is an
        // ordered array of manually-placed {x,y,z} intermediate points
        // the transition routes through, empty until the user adds any
        // via Add Path Point - both straight and every other path type
        // can use pathPoints (a "straight" transition through 3 points is
        // 2 straight segments back to back, see pathTypes.js).
        pathType: DEFAULT_PATH_TYPE,
        pathTarget: null,
        pathPoints: []
    });
    return path.keyframes.length - 1;
}


/**
 * Automatically applies the selected automatic curve mode to every
 * transition once there are at least three authored keyframes.
 *
 * "smooth" uses the continuous Catmull-Rom curve that was added in the
 * previous fix. "circular" uses a true 3-point circle for every transition:
 * each segment is assigned a circle derived from the nearest three
 * consecutive keyframes. With exactly three keyframes, both transitions
 * therefore use the exact same circle through all three points (the original
 * circular behavior). With four or more keyframes, each new transition gets
 * its own local 3-point circle instead of reverting to a straight line.
 *
 * The function name is kept for compatibility with existing callers.
 */
export function autoCircularThreeKeyframes(playerId, replayId) {
    const path = getPath(playerId, replayId);
    const count = path.keyframes.length;

    if (count < 3) {
        clearAutoCurvePaths(path);
        return { applied: false, reason: "need_at_least_three" };
    }

    let appliedCount = 0;
    let circularFallbacks = 0;

    for (let i = 1; i < count; i++) {
        const keyframe = path.keyframes[i];

        // Never overwrite a manually-authored "Curve Here", orbit, focus,
        // or other explicit path choice. Only the automatic straight /
        // smooth / circular3d paths are managed here.
        if (
            keyframe.pathType !== "straight" &&
            keyframe.pathType !== "smooth_curve" &&
            keyframe.pathType !== "circular3d"
        ) {
            continue;
        }

        if (path.curveMode === "circular") {
            const triple = getCircularTriple(path.keyframes, i);
            const circle = buildCircle3d(triple[0], triple[1], triple[2]);

            if (circle) {
                keyframe.pathType = "circular3d";
                keyframe.pathTarget = JSON.parse(JSON.stringify(circle));
                keyframe.pathPoints = [];
                appliedCount++;
            } else {
                // Three collinear points do not define a circle. Fall back
                // only for this segment rather than corrupting the rest of
                // the path. Smooth mode remains available as the explicit
                // alternative through the Curve Mode menu.
                keyframe.pathType = "straight";
                keyframe.pathTarget = null;
                keyframe.pathPoints = [];
                circularFallbacks++;
            }
        } else {
            keyframe.pathType = "smooth_curve";
            keyframe.pathTarget = null;
            keyframe.pathPoints = [];
            appliedCount++;
        }
    }

    return {
        applied: appliedCount > 0,
        appliedCount,
        circularFallbacks
    };
}

/**
 * Returns the three consecutive keyframes used to define the circular arc
 * for the transition INTO keyframe `index`.
 *
 * First segment uses keyframes 1-3; interior segments use the immediately
 * surrounding triple; final segment uses the final three keyframes. This
 * preserves the exact original 3-keyframe circle while allowing an
 * arbitrarily long chain to remain circular.
 */
function getCircularTriple(keyframes, index) {
    const count = keyframes.length;

    if (count === 3) {
        return [
            keyframes[0].location,
            keyframes[1].location,
            keyframes[2].location
        ];
    }

    if (index <= 1) {
        return [
            keyframes[0].location,
            keyframes[1].location,
            keyframes[2].location
        ];
    }

    if (index >= count - 1) {
        return [
            keyframes[count - 3].location,
            keyframes[count - 2].location,
            keyframes[count - 1].location
        ];
    }

    return [
        keyframes[index - 1].location,
        keyframes[index].location,
        keyframes[index + 1].location
    ];
}

/**
 * Calculates the unique 3D circle through three non-collinear points.
 * The returned basis is orthonormal, and the radius is shared by all three
 * points, so circular3d playback stays on the exact circle rather than
 * approximating it with a spline.
 */
function buildCircle3d(a, b, c) {
    const u = sub3(b, a);
    const v = sub3(c, a);
    const nRaw = cross3(u, v);
    const n2 = dot3(nRaw, nRaw);

    if (!Number.isFinite(n2) || n2 < 1e-8) return null;

    const uu = dot3(u, u);
    const vv = dot3(v, v);

    const center = add3(
        a,
        scale3(
            add3(
                scale3(cross3(v, nRaw), uu),
                scale3(cross3(nRaw, u), vv)
            ),
            1 / (2 * n2)
        )
    );

    const radius = distance3(center, a);
    if (!Number.isFinite(radius) || radius < 1e-6) return null;

    const normal = normalize3(nRaw);
    const basisU = normalize3(sub3(a, center));
    const basisV = normalize3(cross3(normal, basisU));

    // basisV is built from the ordered triangle normal, so increasing
    // angle follows the authored keyframe order A -> B -> C. Store that
    // orientation with the circle; playback uses a forward (0..2π) arc
    // instead of the old shortest-angle choice, which could select the
    // opposite arc and make 4+ keyframe circular paths appear to break.
    return {
        mode: "circle3d",
        center,
        normal,
        basisU,
        basisV,
        radius,
        orderedArc: true
    };
}

function clearAutoCurvePaths(path) {
    for (const keyframe of path.keyframes) {
        if (keyframe.pathType === "smooth_curve" || keyframe.pathType === "circular3d") {
            keyframe.pathType = "straight";
            keyframe.pathTarget = null;
            keyframe.pathPoints = [];
        }
    }
}

function sub3(a, b) { return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }; }
function add3(a, b) { return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }; }
function scale3(a, s) { return { x: a.x * s, y: a.y * s, z: a.z * s }; }
function dot3(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
function cross3(a, b) { return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x }; }
function distance3(a, b) { return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z); }
function normalize3(a) {
    const len = Math.hypot(a.x, a.y, a.z);
    return len > 1e-9 ? scale3(a, 1 / len) : { x: 0, y: 0, z: 0 };
}

export function removeKeyframe(playerId, replayId, index) {
    const path = getPath(playerId, replayId);
    if (index < 0 || index >= path.keyframes.length) return false;
    path.keyframes.splice(index, 1);
    if (path.keyframes.length >= 3) autoCircularThreeKeyframes(playerId, replayId);
    else clearAutoCurvePaths(path);
    return true;
}

/** Recaptures an existing keyframe's location/rotation/timelineTick/armorSnapshot to wherever the director and replay timeline are now ("Move Camera"). armorSnapshot is optional so callers that only move the camera (not re-checking armor) can omit it and leave the keyframe's existing snapshot untouched. */
export function updateKeyframeLocation(playerId, replayId, index, location, rotation, timelineTick, armorSnapshot) {
    const path = getPath(playerId, replayId);
    const keyframe = path.keyframes[index];
    if (!keyframe) return false;
    keyframe.location = { ...location };
    keyframe.rotation = { yaw: rotation.y, pitch: rotation.x };
    if (timelineTick !== undefined) {
        keyframe.timelineTick = Math.max(0, Math.round(timelineTick));
    }
    if (armorSnapshot !== undefined) {
        keyframe.armorSnapshot = JSON.parse(JSON.stringify(armorSnapshot));
    }
    if (path.keyframes.length >= 3) {
        autoCircularThreeKeyframes(playerId, replayId);
    } else {
        clearAutoCurvePaths(path);
    }
    return true;
}

export function updateKeyframeTiming(playerId, replayId, index, holdTicks, easing) {
    const path = getPath(playerId, replayId);
    const keyframe = path.keyframes[index];
    if (!keyframe) return false;
    keyframe.holdTicks = holdTicks;
    keyframe.easing = easing;
    return true;
}

/**
 * Custom Camera Path: sets the movement type for the transition INTO a
 * keyframe (index 0 is a no-op the same way its holdTicks/easing already
 * are - nothing transitions into the first keyframe). Silently ignores
 * an unrecognized type rather than storing garbage a later read could
 * choke on - pathTypes.js's registry is the single source of truth for
 * what's valid, mirrored here as VALID_PATH_TYPES to avoid a circular
 * import between the two files.
 * @param {string} playerId
 * @param {string} replayId
 * @param {number} index
 * @param {string} pathType - one of VALID_PATH_TYPES
 */
export function setKeyframePathType(playerId, replayId, index, pathType) {
    if (!VALID_PATH_TYPES.includes(pathType)) return false;
    const path = getPath(playerId, replayId);
    const keyframe = path.keyframes[index];
    if (!keyframe) return false;
    keyframe.pathType = pathType;
    return true;
}

/**
 * Simple curve workflow: the current camera position becomes the single
 * control point for the transition INTO this keyframe. This intentionally
 * hides the old multi-point/advanced curve editing model from the UI while
 * preserving the underlying path format for existing projects.
 *
 * @param {string} playerId
 * @param {string} replayId
 * @param {number} index
 * @param {{x:number,y:number,z:number}} location
 */
export function setKeyframeCurveHere(playerId, replayId, index, location) {
    const path = getPath(playerId, replayId);
    const keyframe = path.keyframes[index];
    if (!keyframe || index <= 0) return false;
    keyframe.pathType = "curve";
    keyframe.pathTarget = null;
    keyframe.pathPoints = [{ ...location }];
    return true;
}

/** Restores the simple direct path for the transition into this keyframe. */
export function clearKeyframeCurve(playerId, replayId, index) {
    const path = getPath(playerId, replayId);
    const keyframe = path.keyframes[index];
    if (!keyframe || index <= 0) return false;
    keyframe.pathType = "straight";
    keyframe.pathTarget = null;
    keyframe.pathPoints = [];
    return true;
}

/**
 * Custom Camera Path: sets the center/focus target for a keyframe's
 * incoming transition (only meaningful for circular/orbit/focus, but
 * storable regardless of the current pathType - switching TO one of
 * those types later doesn't lose a target set earlier).
 * @param {string} playerId
 * @param {string} replayId
 * @param {number} index
 * @param {{mode:"actor", actorPlayerId:string}|{mode:"point", location:{x:number,y:number,z:number}}|null} target - null clears it
 */
export function setKeyframePathTarget(playerId, replayId, index, target) {
    const path = getPath(playerId, replayId);
    const keyframe = path.keyframes[index];
    if (!keyframe) return false;
    keyframe.pathTarget =
        target && target.mode === "point"
            ? { mode: "point", location: { ...target.location } }
            : target && target.mode === "actor"
              ? { mode: "actor", actorPlayerId: target.actorPlayerId }
              : null;
    return true;
}

/**
 * Custom Camera Path: appends a manually-placed intermediate point to a
 * keyframe's incoming transition - the camera routes through these, in
 * order, between the previous keyframe and this one (see pathTypes.js
 * for how each path type actually uses them).
 * @returns {number} the new point's index within this keyframe's pathPoints, or -1 if the keyframe doesn't exist
 */
export function addPathPoint(playerId, replayId, index, location) {
    const path = getPath(playerId, replayId);
    const keyframe = path.keyframes[index];
    if (!keyframe) return -1;
    keyframe.pathPoints.push({ ...location });
    return keyframe.pathPoints.length - 1;
}

export function updatePathPoint(playerId, replayId, index, pointIndex, location) {
    const path = getPath(playerId, replayId);
    const keyframe = path.keyframes[index];
    if (!keyframe || !keyframe.pathPoints[pointIndex]) return false;
    keyframe.pathPoints[pointIndex] = { ...location };
    return true;
}

export function removePathPoint(playerId, replayId, index, pointIndex) {
    const path = getPath(playerId, replayId);
    const keyframe = path.keyframes[index];
    if (!keyframe || pointIndex < 0 || pointIndex >= keyframe.pathPoints.length) return false;
    keyframe.pathPoints.splice(pointIndex, 1);
    return true;
}

/**
 * @param {number} direction - -1 to move earlier in the sequence, +1 to move later
 */
export function movePathPoint(playerId, replayId, index, pointIndex, direction) {
    const path = getPath(playerId, replayId);
    const keyframe = path.keyframes[index];
    if (!keyframe) return false;
    const target = pointIndex + direction;
    if (target < 0 || target >= keyframe.pathPoints.length) return false;
    const [point] = keyframe.pathPoints.splice(pointIndex, 1);
    keyframe.pathPoints.splice(target, 0, point);
    return true;
}

/**
 * @param {string} playerId
 * @param {string} replayId
 * @param {number} index
 * @param {number} direction - -1 to move earlier, +1 to move later
 */
export function moveKeyframe(playerId, replayId, index, direction) {
    const path = getPath(playerId, replayId);
    const target = index + direction;
    if (target < 0 || target >= path.keyframes.length) return false;
    const [keyframe] = path.keyframes.splice(index, 1);
    path.keyframes.splice(target, 0, keyframe);
    if (path.keyframes.length >= 3) autoCircularThreeKeyframes(playerId, replayId);
    else clearAutoCurvePaths(path);
    return true;
}

/**
 * Returns the selected automatic curve mode for this path.
 * "smooth" is the continuous Catmull-Rom mode; "circular" is the exact
 * local 3-point-circle mode.
 */
export function getCurveMode(playerId, replayId) {
    return getPath(playerId, replayId).curveMode;
}

/**
 * Selects the automatic curve algorithm and immediately rebuilds all
 * automatic curve transitions. Existing manually-authored path choices are
 * preserved.
 */
export function setCurveMode(playerId, replayId, mode) {
    if (mode !== "circular" && mode !== "smooth") return false;
    const path = getPath(playerId, replayId);
    path.curveMode = mode;
    // Curve Mode supersedes the former ON/OFF toggle. Selecting either
    // algorithm always enables curved playback/visualization.
    path.curveEnabled = true;

    if (path.keyframes.length >= 3) {
        autoCircularThreeKeyframes(playerId, replayId);
    }

    return true;
}

/** Returns whether automatic/authored curve motion is currently enabled for this path. */
export function isCurveEnabled(playerId, replayId) {
    return getPath(playerId, replayId).curveEnabled !== false;
}

/**
 * Toggles curve rendering/playback without destroying authored curve data.
 * Turning it off makes every curve/smooth_curve transition behave as straight;
 * turning it back on restores the stored curve paths immediately.
 */
export function toggleCurveEnabled(playerId, replayId) {
    const path = getPath(playerId, replayId);
    path.curveEnabled = path.curveEnabled === false;
    return path.curveEnabled;
}

export function clearPath(playerId, replayId) {
    paths.set(pathKey(playerId, replayId), { keyframes: [], curveEnabled: DEFAULT_CURVE_ENABLED });
}

/**
 * Undo/Redo pass: wholesale-replaces a path's keyframes array - used only
 * by keyframeHistory.js's undo()/redo(), which hand this the exact array
 * they captured/restored. Deliberately the only mutation in this file
 * that doesn't validate/normalize its input the way addKeyframe etc do -
 * the array it receives was itself produced by this file's own
 * deep-copy logic (see keyframeHistory.js), so it's already in the
 * correct shape.
 * @param {string} playerId
 * @param {string} replayId
 * @param {Array<object>} keyframes
 */
export function replacePath(playerId, replayId, keyframes) {
    const path = getPath(playerId, replayId);
    path.keyframes = keyframes;
}

/**
 * Removes every director's keyframe path for a given replay (all playerId
 * keys that reference it) - called when that replay is deleted, so its
 * keyframes don't linger in memory under a replayId nothing can reach
 * anymore ("saving one replay must never overwrite another's" implies a
 * deleted replay's keyframes shouldn't resurface if its id were ever reused
 * either).
 * @param {string} replayId
 */
export function clearPathsForReplay(replayId) {
    const suffix = `::${replayId}`;
    for (const key of [...paths.keys()]) {
        if (key.endsWith(suffix)) paths.delete(key);
    }
}
