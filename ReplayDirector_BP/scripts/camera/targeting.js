/**
 * Replay Director - Auto Target Detection
 *
 * Finds the nearest player in front of the director (the stick holder) to
 * automatically become the subject of a cinematic preset.
 */

const MAX_DISTANCE = 32;

/**
 * Finds the nearest other player around the director, regardless of which
 * way the director is facing. Players directly in the crosshair are still
 * given a small preference so an intentional aim wins ties, but a subject
 * behind or to the side of the director is always picked up.
 *
 * @param {import("@minecraft/server").Player} director
 * @returns {import("@minecraft/server").Player|undefined}
 */
export function findAutoTarget(director) {
    const dimension = director.dimension;
    const origin = director.getHeadLocation();
    const viewDir = director.getViewDirection();

    const candidates = dimension
        .getPlayers({ location: origin, maxDistance: MAX_DISTANCE })
        .filter((p) => p.id !== director.id && p.isValid);

    if (candidates.length === 0) return undefined;

    let best;
    let bestScore = Infinity;

    for (const candidate of candidates) {
        const targetLoc = candidate.getHeadLocation();
        const distance = distance3(origin, targetLoc);

        const toTarget = normalize({
            x: targetLoc.x - origin.x,
            y: targetLoc.y - origin.y,
            z: targetLoc.z - origin.z
        });
        const dot = clamp(dot3(viewDir, toTarget), -1, 1);

        // Lower score wins. Distance dominates (any nearby player is a valid
        // target); facing the crosshair only nudges ties in that player's favor.
        const score = distance - dot * 0.75;
        if (score < bestScore) {
            bestScore = score;
            best = candidate;
        }
    }

    return best;
}

/**
 * Finds two nearby players for Conversation Mode presets.
 * @param {import("@minecraft/server").Player} director
 * @returns {[import("@minecraft/server").Player, import("@minecraft/server").Player]|undefined}
 */
export function findConversationPair(director) {
    const dimension = director.dimension;
    const origin = director.location;
    const candidates = dimension
        .getPlayers({ location: origin, maxDistance: MAX_DISTANCE })
        .filter((p) => p.id !== director.id && p.isValid);

    if (candidates.length < 2) return undefined;

    // Closest two players to each other among the candidates near the director.
    let bestPair;
    let bestDist = Infinity;
    for (let i = 0; i < candidates.length; i++) {
        for (let j = i + 1; j < candidates.length; j++) {
            const d = distance3(candidates[i].location, candidates[j].location);
            if (d < bestDist) {
                bestDist = d;
                bestPair = [candidates[i], candidates[j]];
            }
        }
    }
    return bestPair;
}

function normalize(v) {
    const len = Math.hypot(v.x, v.y, v.z) || 1;
    return { x: v.x / len, y: v.y / len, z: v.z / len };
}

function dot3(a, b) {
    return a.x * b.x + a.y * b.y + a.z * b.z;
}

function distance3(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
}
