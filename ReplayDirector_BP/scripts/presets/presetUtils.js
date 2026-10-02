/**
 * Replay Director - Preset Utilities
 *
 * Shared helpers for building shot functions: distance/height presets and
 * a snapshot of the frozen subject so shots don't need to re-read entity
 * state every tick (the subject is frozen anyway, but this also protects
 * against the subject becoming invalid mid-shot).
 */

export const DISTANCE_METERS = {
    near: 3,
    medium: 5.5,
    far: 9,
    extreme: 16
};

export const HEIGHT_OFFSET = {
    low: -0.6,
    eye: 0,
    high: 2.2,
    very_high: 6
};

/**
 * @param {import("@minecraft/server").Player} target
 * @returns {{location: {x:number,y:number,z:number}, headLocation: {x:number,y:number,z:number}, yaw: number}}
 */
export function snapshotSubject(target) {
    const headLocation = target.getHeadLocation();
    const rotation = target.getRotation();
    return {
        location: { ...target.location },
        headLocation: { ...headLocation },
        yaw: rotation.y
    };
}

/**
 * A virtual "subject" halfway between two players, for the Center focus mode.
 * Not a real entity - just a location/heading for presets to orbit/frame around.
 *
 * Its "yaw" points perpendicular to the line connecting the two players, not
 * along it - so a preset that frames "in front of" this subject ends up
 * side-on to both of them (side-by-side in the shot), instead of looking
 * straight down the line between them (which would stack them front-to-back).
 *
 * @param {import("@minecraft/server").Player} playerA
 * @param {import("@minecraft/server").Player} playerB
 */
export function midpointSubject(playerA, playerB) {
    const a = playerA.location;
    const b = playerB.location;
    const aHead = playerA.getHeadLocation();
    const bHead = playerB.getHeadLocation();

    const location = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 };
    const headLocation = { x: (aHead.x + bHead.x) / 2, y: (aHead.y + bHead.y) / 2, z: (aHead.z + bHead.z) / 2 };

    const dx = b.x - a.x;
    const dz = b.z - a.z;
    // yaw whose forward(yaw) = (-sin(yaw), cos(yaw)) is perpendicular to (dx, dz)
    const yaw = (Math.atan2(dz, dx) * 180) / Math.PI;

    return { location, headLocation, yaw };
}

export function toRadians(deg) {
    return (deg * Math.PI) / 180;
}

/**
 * Forward/right unit vectors for a given yaw, matching Minecraft's
 * convention (see pointOnCircle below): forward(yaw) = (-sin(yaw), cos(yaw)),
 * right(yaw) = forward rotated -90deg = (cos(yaw), sin(yaw)). Presets that
 * need to reason in "in front of / behind / to the side of the subject,
 * measured in blocks" terms (rather than "on a circle of some radius")
 * use this instead of re-deriving the trig each time.
 */
export function yawVectors(yawDeg) {
    const rad = toRadians(yawDeg);
    return {
        forward: { x: -Math.sin(rad), z: Math.cos(rad) },
        right: { x: Math.cos(rad), z: Math.sin(rad) }
    };
}

/**
 * "Follow The Player" (Phase 3K camera options). Re-centers an already-
 * generated shot's frame onto a live entity's current position each tick,
 * instead of re-running generate() with a fresh snapshot (which would
 * reset orbit angles/dolly progress back to their t=0 starting values
 * every frame, since presets compute things like `startAngle = subject.yaw`
 * once and sweep from there). Diffs the live snapshot against the frozen
 * one generate() was built from, and shifts both `location` and
 * `facingLocation` by that same delta - so the shot's designed motion
 * plays out exactly as authored, just recentered onto a moving target.
 * Works identically for every preset, existing or new, with no per-preset
 * changes required.
 *
 * @param {(t:number) => {location:{x:number,y:number,z:number}, facingLocation:{x:number,y:number,z:number}, fov?:number}} shotFn
 * @param {{location:{x:number,y:number,z:number}, headLocation:{x:number,y:number,z:number}, yaw:number}} frozenSnapshot - the snapshot the shotFn was generated from
 * @param {() => import("@minecraft/server").Entity|import("@minecraft/server").Player|undefined} getLiveEntity - called every tick; return the live entity to follow, or undefined/invalid to hold the last known delta
 * @returns {(t:number) => {location:object, facingLocation:object, fov?:number}}
 */
export function wrapWithFollow(shotFn, frozenSnapshot, getLiveEntity) {
    let lastDelta = { x: 0, y: 0, z: 0 };
    let lastHeadDelta = { x: 0, y: 0, z: 0 };

    return (t) => {
        const frame = shotFn(t);

        const live = getLiveEntity();
        if (live && live.isValid) {
            try {
                const liveLoc = live.location;
                const liveHead = typeof live.getHeadLocation === "function" ? live.getHeadLocation() : liveLoc;
                lastDelta = {
                    x: liveLoc.x - frozenSnapshot.location.x,
                    y: liveLoc.y - frozenSnapshot.location.y,
                    z: liveLoc.z - frozenSnapshot.location.z
                };
                lastHeadDelta = {
                    x: liveHead.x - frozenSnapshot.headLocation.x,
                    y: liveHead.y - frozenSnapshot.headLocation.y,
                    z: liveHead.z - frozenSnapshot.headLocation.z
                };
            } catch (e) {
                // fail soft - hold the last known delta rather than snapping
            }
        }
        // If the live entity is gone (disconnected mid-shot, etc.), keep
        // using the last delta we successfully read instead of collapsing
        // back to the frozen point - avoids a visible pop.

        return {
            location: {
                x: frame.location.x + lastDelta.x,
                y: frame.location.y + lastDelta.y,
                z: frame.location.z + lastDelta.z
            },
            facingLocation: {
                x: frame.facingLocation.x + lastHeadDelta.x,
                y: frame.facingLocation.y + lastHeadDelta.y,
                z: frame.facingLocation.z + lastHeadDelta.z
            },
            fov: frame.fov
        };
    };
}

/**
 * Point at the given radius/angle around a center, using Minecraft's actual
 * yaw convention: angleDeg = a subject's yaw places the point exactly in the
 * direction that subject is facing (their front), and angleDeg = yaw + 180
 * places it behind them. This must match forward(yaw) = (-sin(yaw), cos(yaw))
 * or every "in front of the subject" shot ends up looking at their back.
 */
export function pointOnCircle(center, radius, angleDeg, yOffset) {
    const rad = toRadians(angleDeg);
    return {
        x: center.x - radius * Math.sin(rad),
        y: center.y + yOffset,
        z: center.z + radius * Math.cos(rad)
    };
}
