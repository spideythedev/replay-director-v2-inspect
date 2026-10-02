/**
 * Replay Director - Manual Camera Path Player (Phase 3H)
 *
 * Converts an authored keyframe list into the exact same "segments" shape
 * playSequence() already consumes for Spawn Showcase - no changes to
 * cameraRunner.js are needed. Each keyframe becomes one segment (the
 * transition from the previous keyframe into it); rotation is converted
 * to a synthetic facingLocation point so it fits the same
 * {location, facingLocation} frame shape every preset already returns,
 * rather than adding a second frame format cameraRunner would need to
 * understand.
 */

import { lerp } from "../core/easing.js";
import { PATH_TYPES, TARGET_LOCKED_FACING_TYPES, resolvePathTarget, lockFacing } from "./pathTypes.js";

const LOOK_AHEAD_DISTANCE = 10; // blocks - far enough that facingLocation reduces to the intended rotation

function resolvePathMotion(keyframes, index, curveEnabled) {
    const from = keyframes[index - 1];
    const to = keyframes[index];

    let pathType = to.pathType || "straight";
    if (curveEnabled === false && (pathType === "curve" || pathType === "smooth_curve")) {
        pathType = "straight";
    }

    const pathTypeFn = PATH_TYPES[pathType] || PATH_TYPES.straight;

    // smooth_curve is an automatic continuous curve through the entire
    // keyframe chain. It needs the previous and next keyframes as the two
    // Catmull-Rom tangent controls; the endpoint duplicates itself where a
    // neighbor does not exist.
    const points = pathType === "smooth_curve"
        ? [
            keyframes[index - 2]?.location || from.location,
            keyframes[index + 1]?.location || to.location
        ]
        : (to.pathPoints || []);

    const usesTargetFacing = TARGET_LOCKED_FACING_TYPES.has(pathType);
    return { pathType, pathTypeFn, points, usesTargetFacing };
}

/**
 * @param {Array<{location:object, rotation:{yaw:number,pitch:number}, holdTicks:number, easing:string, pathType?:string, pathTarget?:object, pathPoints?:Array<object>}>} keyframes
 * @param {() => Array<{playerId:string, entity:object}>} [getActiveActors] - injected so orbit/focus can resolve an actor-mode pathTarget's LIVE position each frame (see pathTypes.js's resolvePathTarget); omit when there's no replay context to resolve actors against (e.g. a standalone path with no replay playing) - an actor-mode target simply won't resolve and that transition falls back to straight, same as having no target set at all.
 * @returns {Array<{durationTicks:number, easing:string, shotFn:Function, sway:boolean}>}
 */
export function buildSegments(keyframes, { sway = true, getActiveActors, curveEnabled = true } = {}) {
    const segments = [];

    for (let i = 1; i < keyframes.length; i++) {
        const from = keyframes[i - 1];
        const to = keyframes[i];
        const motion = resolvePathMotion(keyframes, i, curveEnabled);

        segments.push({
            durationTicks: Math.max(1, to.holdTicks),
            easing: to.easing,
            sway,
            shotFn: (t) => {
                // Resolved fresh every frame (not once per segment build)
                // so an actor-mode target tracks that actor's live moving
                // position throughout the transition - see pathTypes.js.
                const target = resolvePathTarget(to.pathTarget, getActiveActors);
                const location = motion.pathTypeFn(from.location, to.location, motion.points, target, t);

                if (motion.usesTargetFacing && target) {
                    return { location, facingLocation: lockFacing(location, target) };
                }

                const yaw = lerpAngle(from.rotation.yaw, to.rotation.yaw, t);
                const pitch = lerp(from.rotation.pitch, to.rotation.pitch, t);
                return {
                    location,
                    facingLocation: projectFacingPoint(location, yaw, pitch)
                };
            }
        });
    }

    return segments;
}

/** Total playback duration in ticks for a keyframe list (sum of every transition's holdTicks). */
export function totalDuration(keyframes) {
    let total = 0;
    for (let i = 1; i < keyframes.length; i++) {
        total += Math.max(1, keyframes[i].holdTicks);
    }
    return total;
}

/**
 * Timeline-locked variant of buildSegments() for Preview Path (Phase 3J).
 *
 * buildSegments()/totalDuration() above are unchanged and still power
 * "Play Camera Animation" - an intentionally independent camera-only run
 * paced by each keyframe's authored holdTicks, with no replay attached.
 *
 * Preview Path is different: it has to show the SAME cinematic the final
 * output will have, which means the camera has to reach each keyframe
 * exactly when the replay timeline reaches that keyframe's timelineTick -
 * not after holdTicks worth of camera-local ticks have elapsed. So each
 * segment here is stamped with the absolute replay ticks it spans
 * (startTick/endTick, taken straight from the keyframes' timelineTick),
 * and the caller (playTimelineSequence in cameraRunner.js) computes t from
 * the replay's live playhead against those ticks every frame, instead of
 * counting its own elapsed ticks. holdTicks/easing on the FIRST keyframe
 * are still irrelevant (nothing transitions into it); easing on every
 * other keyframe is preserved so eased transitions still look eased.
 *
 * Keyframes are expected to be in ascending timelineTick order for a
 * sensible preview (earlier-captured keyframes naturally come first from
 * addKeyframe, and reordering is manual/deliberate via moveKeyframe) - if
 * two keyframes ever share a timelineTick, the span is clamped to a
 * minimum of 1 tick so t stays well-defined instead of dividing by zero.
 *
 * @param {Array<{location:object, rotation:{yaw:number,pitch:number}, timelineTick:number, holdTicks:number, easing:string}>} keyframes
 * @returns {Array<{startTick:number, endTick:number, easing:string, shotFn:Function, sway:boolean}>}
 */
/**
 * @param {Array<{location:object, rotation:{yaw:number,pitch:number}, timelineTick:number, holdTicks:number, easing:string, pathType?:string, pathTarget?:object, pathPoints?:Array<object>}>} keyframes
 * @param {() => Array<{playerId:string, entity:object}>} [getActiveActors] - same as buildSegments above; Preview Path always has a live replay (it's gated on isPlaying()), so this is expected to actually resolve actor targets in practice, unlike buildSegments' standalone case.
 * @returns {Array<{startTick:number, endTick:number, easing:string, shotFn:Function, sway:boolean}>}
 */
export function buildTimelineSegments(keyframes, { sway = false, getActiveActors, curveEnabled = true } = {}) {
    const segments = [];
    // Preview is locked to the replay timeline, so its input must be
    // chronological even if the editor has deliberately reordered the
    // authored camera sequence. The normal "Play Camera Animation" path
    // still uses the authored order via buildSegments().
    const timelineKeyframes = sortKeyframesByTimeline(keyframes);

    for (let i = 1; i < timelineKeyframes.length; i++) {
        const from = timelineKeyframes[i - 1];
        const to = timelineKeyframes[i];
        const startTick = from.timelineTick;
        const endTick = Math.max(startTick + 1, to.timelineTick);
        const motion = resolvePathMotion(timelineKeyframes, i, curveEnabled);

        segments.push({
            startTick,
            endTick,
            easing: to.easing,
            sway,
            shotFn: (t) => {
                const target = resolvePathTarget(to.pathTarget, getActiveActors);
                const location = motion.pathTypeFn(from.location, to.location, motion.points, target, t);

                if (motion.usesTargetFacing && target) {
                    return { location, facingLocation: lockFacing(location, target) };
                }

                const yaw = lerpAngle(from.rotation.yaw, to.rotation.yaw, t);
                const pitch = lerp(from.rotation.pitch, to.rotation.pitch, t);
                return {
                    location,
                    facingLocation: projectFacingPoint(location, yaw, pitch)
                };
            }
        });
    }

    return segments;
}

/** First replay tick a timeline segment list covers (the first keyframe's timelineTick), or 0 if there are none. */
export function sortKeyframesByTimeline(keyframes) {
    return keyframes
        .map((keyframe, index) => ({ keyframe, index }))
        .sort((a, b) => {
            const tickA = Number.isFinite(a.keyframe.timelineTick) ? a.keyframe.timelineTick : 0;
            const tickB = Number.isFinite(b.keyframe.timelineTick) ? b.keyframe.timelineTick : 0;
            return tickA - tickB || a.index - b.index;
        })
        .map(({ keyframe }) => keyframe);
}

/** First replay tick a timeline segment list covers, or 0 if there are none. */
export function firstTimelineTick(keyframes) {
    const sorted = sortKeyframesByTimeline(keyframes);
    return sorted.length > 0 ? sorted[0].timelineTick : 0;
}

/** Last replay tick a timeline segment list covers, or 0 if there are none. */
export function lastTimelineTick(keyframes) {
    const sorted = sortKeyframesByTimeline(keyframes);
    return sorted.length > 0 ? sorted[sorted.length - 1].timelineTick : 0;
}

/** Shortest-path interpolation between two angles in degrees (never spins the long way around). */
function lerpAngle(a, b, t) {
    const diff = (((b - a + 180) % 360) + 360) % 360 - 180;
    return a + diff * t;
}

function projectFacingPoint(location, yawDeg, pitchDeg) {
    const yaw = (yawDeg * Math.PI) / 180;
    const pitch = (pitchDeg * Math.PI) / 180;
    const dirX = -Math.sin(yaw) * Math.cos(pitch);
    const dirY = -Math.sin(pitch);
    const dirZ = Math.cos(yaw) * Math.cos(pitch);
    return {
        x: location.x + dirX * LOOK_AHEAD_DISTANCE,
        y: location.y + dirY * LOOK_AHEAD_DISTANCE,
        z: location.z + dirZ * LOOK_AHEAD_DISTANCE
    };
}
