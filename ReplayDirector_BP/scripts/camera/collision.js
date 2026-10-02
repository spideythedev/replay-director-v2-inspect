/**
 * Replay Director - Camera Collision
 *
 * Raycasts from the cinematic subject out toward the desired camera
 * position each tick. If a block is in the way, the camera is pulled
 * in to just before that block instead of clipping through walls.
 */

/**
 * @param {import("@minecraft/server").Dimension} dimension
 * @param {{x:number,y:number,z:number}} anchor - usually the subject's head location
 * @param {{x:number,y:number,z:number}} desiredLocation - where the shot wants the camera
 * @returns {{x:number,y:number,z:number}} a collision-safe camera location
 */
export function resolveCameraCollision(dimension, anchor, desiredLocation) {
    const dx = desiredLocation.x - anchor.x;
    const dy = desiredLocation.y - anchor.y;
    const dz = desiredLocation.z - anchor.z;
    const distance = Math.hypot(dx, dy, dz);
    if (distance < 0.5) return desiredLocation;

    const direction = { x: dx / distance, y: dy / distance, z: dz / distance };

    let hit;
    try {
        hit = dimension.getBlockFromRay(anchor, direction, {
            maxDistance: distance,
            includeLiquidBlocks: false,
            includePassableBlocks: false
        });
    } catch (e) {
        return desiredLocation; // fail soft - no collision data available
    }

    if (!hit) return desiredLocation;

    const hitDistance = distanceTo(anchor, hit.block.location);
    const safeDistance = Math.max(0.75, hitDistance - 0.9);

    if (safeDistance >= distance) return desiredLocation;

    return {
        x: anchor.x + direction.x * safeDistance,
        y: anchor.y + direction.y * safeDistance,
        z: anchor.z + direction.z * safeDistance
    };
}

function distanceTo(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}
