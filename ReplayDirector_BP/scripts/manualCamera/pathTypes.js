/**
 * Replay Director - Custom Camera Path Types
 *
 * A small pluggable registry mapping a path type name to a function that
 * computes the camera's location (and, for target-locked types, its
 * facing) at progress t (0-1) through one keyframe transition. This is
 * the ONLY thing pathPlayer.js's buildSegments()/buildTimelineSegments()
 * delegate to for "how does the camera move between these two
 * keyframes" - everything else (holdTicks pacing, easing, timeline
 * lock-step, sway, countdown, collision) is completely unchanged and
 * lives entirely outside this file, in cameraRunner.js/pathPlayer.js as
 * it already did.
 *
 * Adding a new path type later means adding one new entry to PATH_TYPES
 * below with the same (from, to, points, target, t) signature - nothing
 * in pathPlayer.js, cameraRunner.js, or the UI menus needs to change,
 * since they all just read whatever pathType string is stored on a
 * keyframe and look it up here.
 *
 * Signature every path type function shares:
 *   (from, to, points, target, t) => {x,y,z}
 * - from/to: the two keyframes' {x,y,z} locations bounding this transition
 * - points: ordered array of manually-placed {x,y,z} intermediate points
 *   (pathState.js's pathPoints on the TO keyframe) - empty array if none
 * - target: resolved {x,y,z} center/focus point for circular/orbit/focus,
 *   or undefined if this transition has no target set (see
 *   resolvePathTarget below - callers resolve the target ONCE per frame
 *   from the possibly-live actor position, not once per path build, so
 *   orbiting a moving replay actor tracks them correctly)
 * - t: 0-1 progress through this transition (already eased by the
 *   caller - path type functions never see raw linear time verrsus eased
 *   time, they're the same by the time this runs)
 * Returns the camera's {x,y,z} location at that point in the transition.
 * Facing (facingLocation) is computed separately by the caller for
 * straight/curve/circular (interpolated from authored keyframe rotation,
 * exactly as before this feature existed) and by lockFacing() below for
 * orbit/focus (continuously pointed at the target instead).
 */

import { lerpVec3, lerp } from "../core/easing.js";

/**
 * Builds the ordered waypoint list a transition actually routes through:
 * [from, ...manually-placed points, to]. Every multi-point path type
 * (straight-through-points, curve, circular's arc) is built from this
 * same list, so "combine path points with path types" (the user-facing
 * requirement) falls out naturally rather than needing special-case
 * wiring per type.
 */
function waypoints(from, to, points) {
    return [from, ...points, to];
}

/**
 * Straight: the original behavior when there are no path points (a
 * single lerpVec3, unchanged from before this feature) - and, when
 * points ARE present, a straight-line chain through each of them in
 * order. Each leg gets an equal share of t's 0-1 range, proportional to
 * that leg's actual distance so the camera doesn't visibly speed up/slow
 * down crossing a short leg next to a long one.
 */
function straight(from, to, points, target, t) {
    const pts = waypoints(from, to, points);
    return pointOnPolyline(pts, t);
}

/**
 * Smooth Curve: Catmull-Rom spline through [from, ...points, to] - a
 * standard, well-known smooth-interpolation technique (each segment
 * blends using its two neighboring waypoints so the path has no sharp
 * corners at each point, unlike straight's polyline). Falls back to
 * straight's polyline behavior when there are fewer than 2 waypoints
 * total between from/to (nothing to curve through), which only happens
 * with zero path points - the plain from->to case is still a smooth
 * single Catmull-Rom segment using from/to as their own neighbors.
 */
function curve(from, to, points, target, t) {
    // Simple Curve Here workflow: exactly one control point produces a
    // predictable quadratic Bezier arc. This is intentionally easy to author:
    // stand where you want the camera to bend and press "Curve Here".
    if (points && points.length === 1) {
        return quadraticBezier(from, points[0], to, t);
    }

    // Preserve compatibility with older/advanced paths that already contain
    // multiple path points.
    const pts = waypoints(from, to, points || []);
    return pointOnCatmullRom(pts, t);
}

/**
 * Continuous automatic curve: the two supplied points are the neighboring
 * keyframes around the current from -> to transition. This lets the spline
 * continue smoothly when a fourth, fifth, etc. keyframe is added.
 */
function smoothCurve(from, to, points, target, t) {
    const previous = points?.[0] || from;
    const next = points?.[1] || to;
    return catmullRomPoint(previous, from, to, next, t);
}

function quadraticBezier(from, control, to, t) {
    const u = 1 - t;
    const uu = u * u;
    const tt = t * t;
    const ut2 = 2 * u * t;
    return {
        x: uu * from.x + ut2 * control.x + tt * to.x,
        y: uu * from.y + ut2 * control.y + tt * to.y,
        z: uu * from.z + ut2 * control.z + tt * to.z
    };
}

/**
 * Circular: the camera arcs from `from` to `to` while staying
 * (approximately) equidistant from `target`'s horizontal position -
 * height still interpolates linearly from->to so the arc isn't forced
 * flat. Falls back to straight() when no target is set (nothing to
 * circle around), since an untargeted "circular" transition has no
 * mathematical center to use - the UI is expected to prompt for a
 * target when this type is selected, but this fallback keeps playback
 * safe even if one somehow isn't set.
 */
function circular(from, to, points, target, t) {
    if (!target) return straight(from, to, points, target, t);

    const startAngle = Math.atan2(from.z - target.z, from.x - target.x);
    const endAngle = Math.atan2(to.z - target.z, to.x - target.x);
    const startRadius = Math.hypot(from.x - target.x, from.z - target.z);
    const endRadius = Math.hypot(to.x - target.x, to.z - target.z);

    // Shortest-path angle interpolation (never sweeps the long way
    // around) - same idea as pathPlayer.js's existing lerpAngle for
    // rotation, applied here to the orbit angle instead.
    const angle = startAngle + shortestAngleDiff(startAngle, endAngle) * t;
    const radius = lerp(startRadius, endRadius, t);

    return {
        x: target.x + Math.cos(angle) * radius,
        y: lerp(from.y, to.y, t),
        z: target.z + Math.sin(angle) * radius
    };
}

/**
 * Circular 3D: follows the unique circle defined by three keyframes.
 * The pathTarget stores the derived center/basis so both adjacent
 * transitions share exactly the same circle. If metadata is missing or
 * invalid, playback safely falls back to a straight transition.
 */
function circular3d(from, to, points, target, t) {
    if (!target || target.mode !== "circle3d") return straight(from, to, points, target, t);
    const { center, basisU, basisV } = target;
    if (!center || !basisU || !basisV) return straight(from, to, points, target, t);

    const fromRadius = distance(from, center);
    const toRadius = distance(to, center);
    if (!Number.isFinite(fromRadius) || !Number.isFinite(toRadius) || fromRadius < 1e-6 || toRadius < 1e-6) {
        return straight(from, to, points, target, t);
    }

    const fromR = normalize3(sub3(from, center));
    const toR = normalize3(sub3(to, center));
    const a0 = Math.atan2(dot3(fromR, basisV), dot3(fromR, basisU));
    const a1 = Math.atan2(dot3(toR, basisV), dot3(toR, basisU));
    // Automatic circular paths are built from an ORDERED triple of
    // keyframes. The shortest arc is not necessarily the arc that follows
    // that order: for some four/five/six-keyframe layouts the old
    // shortestAngleDiff() chose the opposite side of the same circle.
    // That is the source of the intermittent "circular mode turns
    // straight/wrong" reports. When the path metadata was produced by
    // pathState.buildCircle3d(), positive angular progress is the ordered
    // A -> B -> C direction. Use the forward 0..2π delta so the segment
    // stays on the authored circular arc. Older circle3d metadata without
    // orderedArc safely keeps the legacy shortest-arc behavior.
    const delta = target.orderedArc
        ? forwardAngleDelta(a0, a1)
        : shortestAngleDiff(a0, a1);
    const angle = a0 + delta * t;
    const radius = Number.isFinite(target.radius) && target.radius > 1e-6
        ? target.radius
        : fromRadius + (toRadius - fromRadius) * t;

    return add3(center, scale3(add3(scale3(basisU, Math.cos(angle)), scale3(basisV, Math.sin(angle))), radius));
}

function sub3(a, b) { return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }; }
function add3(a, b) { return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }; }
function scale3(a, s) { return { x: a.x * s, y: a.y * s, z: a.z * s }; }
function dot3(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
function distance(a, b) { return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z); }
function normalize3(a) { const len = Math.hypot(a.x, a.y, a.z); return len > 1e-9 ? scale3(a, 1 / len) : { x: 0, y: 0, z: 0 }; }

/**
 * Orbit: same positional math as circular (it IS a circular arc around
 * the target), but conceptually distinct per the spec - "moves around a
 * target while maintaining focus on it." The distinction that matters is
 * in facing (see lockFacing below, used by pathPlayer.js for both orbit
 * and focus): circular keeps the AUTHORED keyframe rotation interpolated
 * normally, orbit/focus override facing to continuously track the
 * target regardless of authored rotation. Kept as a separate named
 * function (rather than aliasing circular directly) so a future,
 * different orbit motion - e.g. always a full 360 regardless of
 * from/to's actual angle - can change independently of circular without
 * disturbing circular's simpler arc.
 */
function orbit(from, to, points, target, t) {
    return circular(from, to, points, target, t);
}

/**
 * Focus Point: positional movement follows the SAME waypoint path as
 * straight/curve (from -> points -> to, straight-line legs) - the only
 * thing "Focus Point" changes is facing, which pathPlayer.js locks to
 * the target via lockFacing() instead of interpolating authored
 * rotation. Falls back cleanly with no target set (identical to
 * straight in that case - facing just won't be overridden since
 * pathPlayer.js only calls lockFacing when a target actually resolved).
 */
function focus(from, to, points, target, t) {
    return straight(from, to, points, target, t);
}

export const PATH_TYPES = {
    straight,
    curve,
    smooth_curve: smoothCurve,
    circular,
    circular3d,
    orbit,
    focus
};

/** Path types where facing should be locked to the target (via lockFacing below) instead of interpolated from authored keyframe rotation - checked by pathPlayer.js once per segment, not per-frame, so this list is the single source of truth for that behavior split. */
export const TARGET_LOCKED_FACING_TYPES = new Set(["orbit", "focus"]);

/** Path types where a target is meaningful at all - used by the UI to decide whether to show target-related options for a given pathType. Circular technically works without one (falls back to straight above) but a target IS the point of choosing it, so it's listed as needing one same as orbit/focus. */
export const TARGET_CAPABLE_TYPES = new Set(["circular", "orbit", "focus"]);

/**
 * Resolves a stored pathTarget ({mode:"actor",...} or {mode:"point",...})
 * to a concrete {x,y,z} for THIS exact moment - called fresh every frame
 * by pathPlayer.js's shotFn, not once when the path is built, so
 * orbiting/focusing a replay actor correctly tracks their live moving
 * position throughout the transition rather than freezing on wherever
 * they were when the target was set.
 * @param {{mode:"actor",actorPlayerId:string}|{mode:"point",location:object}|null} pathTarget
 * @param {() => Array<{playerId:string, entity:import("@minecraft/server").Entity}>} getActiveActors - injected rather than imported directly, so this file has no dependency on replay/playback.js and stays usable from any context (e.g. a future non-replay camera tool) that can supply its own actor lookup
 * @returns {{x:number,y:number,z:number}|undefined} undefined if unset, or if an actor target's entity isn't currently live (actor not spawned/despawned) - callers already handle "no target" by falling back to straight()
 */
export function resolvePathTarget(pathTarget, getActiveActors) {
    if (!pathTarget) return undefined;
    if (pathTarget.mode === "point") return { ...pathTarget.location };
    if (pathTarget.mode === "circle3d") return pathTarget;
    if (pathTarget.mode === "actor") {
        try {
            const activeActors = getActiveActors ? getActiveActors() : [];
            const match = activeActors.find((a) => a.playerId === pathTarget.actorPlayerId);
            if (match && match.entity && match.entity.isValid) {
                return { ...match.entity.location };
            }
        } catch (e) {
            // fail soft - actor lookup unavailable (e.g. no replay
            // playing right now) falls through to undefined below
        }
    }
    return undefined;
}

/**
 * Computes a facingLocation that continuously points at `target` from
 * `location` - used by pathPlayer.js in place of the normal authored-
 * rotation interpolation, only for orbit/focus (TARGET_LOCKED_FACING_TYPES),
 * only when a target actually resolved this frame (see resolvePathTarget).
 */
export function lockFacing(location, target) {
    return { ...target };
}

/** Shortest-path angle difference in radians (-PI to PI) - orbit/circular's rotation-independent version of pathPlayer.js's own lerpAngle (which works in degrees, for authored rotation). Kept separate rather than shared/converted, since the two operate in different units for unrelated reasons (this is a raw atan2 angle, that's a yaw). */
function forwardAngleDelta(a, b) {
    let diff = b - a;
    while (diff < 0) diff += Math.PI * 2;
    while (diff >= Math.PI * 2) diff -= Math.PI * 2;
    return diff;
}

function shortestAngleDiff(a, b) {
    let diff = b - a;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    return diff;
}

/**
 * Walks a straight-line polyline through an ordered list of waypoints,
 * returning the point at overall progress t (0-1) - each leg's share of
 * t is proportional to that leg's actual distance, so speed stays
 * visually constant across legs of different lengths instead of t=0.5
 * always meaning "halfway by waypoint count" regardless of how far apart
 * they are.
 */
function pointOnPolyline(pts, t) {
    if (pts.length < 2) return { ...pts[0] };
    const legLengths = [];
    let totalLength = 0;
    for (let i = 1; i < pts.length; i++) {
        const len = distance(pts[i - 1], pts[i]);
        legLengths.push(len);
        totalLength += len;
    }
    // Degenerate case: every waypoint at the same location (zero total
    // length) - fall back to the first point rather than dividing by
    // zero; there's nowhere for a "position along the path" to mean
    // anything different anyway.
    if (totalLength === 0) return { ...pts[0] };

    let distanceIntoPath = t * totalLength;
    for (let i = 0; i < legLengths.length; i++) {
        if (distanceIntoPath <= legLengths[i] || i === legLengths.length - 1) {
            const legT = legLengths[i] === 0 ? 0 : distanceIntoPath / legLengths[i];
            return lerpVec3(pts[i], pts[i + 1], Math.min(1, Math.max(0, legT)));
        }
        distanceIntoPath -= legLengths[i];
    }
    return { ...pts[pts.length - 1] };
}

/**
 * Catmull-Rom spline through an ordered list of waypoints, parameterized
 * by overall progress t (0-1) using the same distance-proportional
 * per-leg mapping as pointOnPolyline above (so curve and straight move
 * through the same points at visually comparable pacing, differing only
 * in smoothness). Standard 4-point Catmull-Rom (p0,p1,p2,p3 with p1->p2
 * being the actual segment drawn); endpoints reuse their own neighbor as
 * a stand-in p0/p3 (a common, simple way to define the spline's
 * behavior at the very first/last leg, where a real 4th neighboring
 * point doesn't exist).
 */
function pointOnCatmullRom(pts, t) {
    if (pts.length < 3) return pointOnPolyline(pts, t); // nothing to curve through beyond a single straight segment

    const legLengths = [];
    let totalLength = 0;
    for (let i = 1; i < pts.length; i++) {
        const len = distance(pts[i - 1], pts[i]);
        legLengths.push(len);
        totalLength += len;
    }
    if (totalLength === 0) return { ...pts[0] };

    let distanceIntoPath = t * totalLength;
    let segmentIndex = 0;
    let legT = 0;
    for (let i = 0; i < legLengths.length; i++) {
        if (distanceIntoPath <= legLengths[i] || i === legLengths.length - 1) {
            segmentIndex = i;
            legT = legLengths[i] === 0 ? 0 : Math.min(1, Math.max(0, distanceIntoPath / legLengths[i]));
            break;
        }
        distanceIntoPath -= legLengths[i];
    }

    const p0 = pts[Math.max(0, segmentIndex - 1)];
    const p1 = pts[segmentIndex];
    const p2 = pts[segmentIndex + 1];
    const p3 = pts[Math.min(pts.length - 1, segmentIndex + 2)];

    return catmullRomPoint(p0, p1, p2, p3, legT);
}

/** Standard Catmull-Rom spline formula, applied per-axis. */
function catmullRomPoint(p0, p1, p2, p3, t) {
    const t2 = t * t;
    const t3 = t2 * t;
    return {
        x: catmullRomAxis(p0.x, p1.x, p2.x, p3.x, t, t2, t3),
        y: catmullRomAxis(p0.y, p1.y, p2.y, p3.y, t, t2, t3),
        z: catmullRomAxis(p0.z, p1.z, p2.z, p3.z, t, t2, t3)
    };
}

function catmullRomAxis(v0, v1, v2, v3, t, t2, t3) {
    return 0.5 * (2 * v1 + (-v0 + v2) * t + (2 * v0 - 5 * v1 + 4 * v2 - v3) * t2 + (-v0 + 3 * v1 - 3 * v2 + v3) * t3);
}

