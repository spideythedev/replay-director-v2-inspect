/**
 * Replay Director - Obstruction Detector
 *
 * Scans around a point for the nearest solid block (wall/tree/rock/
 * building) by casting rays outward on a compass of directions. Used by
 * Reveal Shot to auto-find something to start the camera hidden behind.
 *
 * The returned angleDeg uses the same convention as presetUtils.pointOnCircle
 * (forward(angleDeg) = (-sin, cos)) so callers can reuse the exact angle to
 * place camera positions along that same line.
 */

const SAMPLE_COUNT = 16;
const MIN_DISTANCE = 2;
const MAX_DISTANCE = 10;

/**
 * @param {import("@minecraft/server").Dimension} dimension
 * @param {{x:number,y:number,z:number}} origin - usually the subject's head location
 * @returns {{angleDeg: number, distance: number}|undefined}
 */
export function findNearbyObstruction(dimension, origin) {
    let best;

    for (let i = 0; i < SAMPLE_COUNT; i++) {
        const angleDeg = (360 / SAMPLE_COUNT) * i;
        const rad = (angleDeg * Math.PI) / 180;
        const direction = { x: -Math.sin(rad), y: 0, z: Math.cos(rad) };

        let hit;
        try {
            hit = dimension.getBlockFromRay(origin, direction, {
                maxDistance: MAX_DISTANCE,
                includeLiquidBlocks: false,
                includePassableBlocks: false
            });
        } catch (e) {
            continue;
        }

        if (!hit) continue;

        const distance = Math.hypot(
            hit.block.location.x + 0.5 - origin.x,
            hit.block.location.y + 0.5 - origin.y,
            hit.block.location.z + 0.5 - origin.z
        );

        if (distance < MIN_DISTANCE) continue;
        if (!best || distance < best.distance) {
            best = { angleDeg, distance };
        }
    }

    return best;
}
