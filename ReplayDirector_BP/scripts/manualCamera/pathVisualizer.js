/**
 * Replay Director - Camera Path Visualization
 *
 * Lightweight editor-only visualization.
 *
 * The guide mirrors the authored camera path type for each transition:
 * straight, curve, circular, orbit, or focus. It is visual-only and does
 * not change camera playback.
 */

import { system } from "@minecraft/server";
import { getPath } from "./pathState.js";
import { PATH_TYPES } from "./pathTypes.js";

const REDRAW_INTERVAL_TICKS = 6; // ~3.3 redraws/sec.
const LINE_PARTICLE = "replay_director:path_line";
const SHINE_PARTICLE = "replay_director:keyframe_shine";

// A longer-lived, overlapping segment is used instead of short-lived dots.
// This prevents visible gaps/flicker between redraws.
const LINE_SPACING_BLOCKS = 0.22;
const MAX_LINE_PARTICLES_PER_DRAW = 512;
const MIN_PARTICLES_PER_SEGMENT = 2;
const MAX_KEYFRAME_LABELS = 99;

const activeVisualizers = new Map();

/**
 * Starts/restarts live editor visualization for one player.
 * @param {import("@minecraft/server").Player} player
 * @param {string|undefined} replayId
 * @param {() => number|undefined} getSelectedIndex
 */
export function startPathVisualization(player, replayId, getSelectedIndex) {
    stopPathVisualization(player);

    let visualizerFrame = 0;
    const intervalId = system.runInterval(() => {
        if (!player.isValid) {
            stopPathVisualization(player);
            return;
        }

        const path = getPath(player.id, replayId);
        drawPath(
            player,
            path.keyframes,
            path.curveEnabled !== false,
            getSelectedIndex ? getSelectedIndex() : undefined,
            ++visualizerFrame % 6 === 0
        );
    }, REDRAW_INTERVAL_TICKS);

    activeVisualizers.set(player.id, intervalId);
}

/** Stops the editor-only visualization. */
export function stopPathVisualization(player) {
    if (!player) return;
    const existing = activeVisualizers.get(player.id);
    if (existing !== undefined) {
        system.clearRun(existing);
        activeVisualizers.delete(player.id);
    }
}

/**
 * Draws the actual authored camera path between adjacent keyframes.
 *
 * Every transition uses the pathType stored on the TO keyframe, matching
 * pathPlayer.js. Curve transitions therefore render as curves instead of
 * being incorrectly displayed as straight lines.
 *
 * The particle budget is distributed across ALL transitions so later
 * keyframes never disappear simply because the first few segments are long.
 */
function drawPath(player, keyframes, curveEnabled, selectedIndex, addShine) {
    if (!keyframes || keyframes.length === 0) return;

    const dimension = player.dimension;
    const segments = [];

    let totalEstimatedLength = 0;

    for (let i = 1; i < keyframes.length; i++) {
        const from = keyframes[i - 1].location;
        const to = keyframes[i].location;
        let pathType = keyframes[i].pathType || "straight";
        if (curveEnabled === false && (pathType === "curve" || pathType === "smooth_curve")) {
            pathType = "straight";
        }
        const points = pathType === "smooth_curve"
            ? [
                keyframes[i - 2]?.location || from,
                keyframes[i + 1]?.location || to
            ]
            : (keyframes[i].pathPoints || []);
        const target =
            keyframes[i].pathTarget?.mode === "point"
                ? keyframes[i].pathTarget.location
                : keyframes[i].pathTarget?.mode === "circle3d"
                  ? keyframes[i].pathTarget
                  : undefined;

        const pathFn = PATH_TYPES[pathType] || PATH_TYPES.straight;
        const estimatedLength = estimatePathLength(pathFn, from, to, points, target);

        if (estimatedLength > 0.01) {
            segments.push({ from, to, points, target, pathFn, estimatedLength });
            totalEstimatedLength += estimatedLength;
        }
    }

    if (segments.length > 0 && totalEstimatedLength > 0) {
        const budget = Math.max(
            segments.length * MIN_PARTICLES_PER_SEGMENT,
            MAX_LINE_PARTICLES_PER_DRAW
        );

        // If the theoretical minimum exceeds the budget, every segment still
        // receives at least one segment rather than disappearing entirely.
        const usableBudget = Math.max(
            segments.length,
            Math.min(MAX_LINE_PARTICLES_PER_DRAW, budget)
        );

        let remaining = usableBudget;

        for (let i = 0; i < segments.length; i++) {
            const segment = segments[i];
            const isLast = i === segments.length - 1;

            const proportional = Math.round(
                (segment.estimatedLength / totalEstimatedLength) * usableBudget
            );

            const particles = isLast
                ? Math.max(1, remaining)
                : Math.max(
                      1,
                      Math.min(
                          remaining - Math.max(0, segments.length - i - 1),
                          proportional
                      )
                  );

            drawSegment(dimension, segment, particles);
            remaining -= particles;
        }
    }

    // Numbered red keyframe badges. Labels are camera-facing and positioned
    // slightly above the keyframe so terrain does not hide them.
    for (let i = 0; i < keyframes.length && i < MAX_KEYFRAME_LABELS; i++) {
        spawnNumberedMarker(dimension, player, keyframes[i].location, i + 1);
        if (addShine && i === selectedIndex) {
            spawnSafe(dimension, SHINE_PARTICLE, {
                x: keyframes[i].location.x,
                y: keyframes[i].location.y + 0.12,
                z: keyframes[i].location.z
            });
        }
    }
}

function drawSegment(dimension, segment, particleCount) {
    const count = Math.max(1, particleCount);

    // Spawn at the centers of equal progress intervals. The particle itself
    // is wider than the interval and has a longer lifetime than the redraw
    // period, so adjacent redraws overlap rather than blinking.
    for (let i = 0; i < count; i++) {
        const t = (i + 0.5) / count;
        const point = segment.pathFn(
            segment.from,
            segment.to,
            segment.points,
            segment.target,
            t
        );

        spawnSafe(dimension, LINE_PARTICLE, point);
    }
}

function estimatePathLength(pathFn, from, to, points, target) {
    const samples = 16;
    let previous = pathFn(from, to, points, target, 0);
    let length = 0;

    for (let i = 1; i <= samples; i++) {
        const current = pathFn(
            from,
            to,
            points,
            target,
            i / samples
        );
        length += distance(previous, current);
        previous = current;
    }

    return length;
}

function distance(a, b) {
    return Math.hypot(
        a.x - b.x,
        a.y - b.y,
        a.z - b.z
    );
}

function spawnNumberedMarker(dimension, player, location, number) {
    const digits = String(number);
    const yaw = ((player.getRotation().y ?? 0) * Math.PI) / 180;

    const rightX = Math.cos(yaw);
    const rightZ = Math.sin(yaw);

    const spacing = digits.length === 1 ? 0 : 0.30;
    const start = -((digits.length - 1) * spacing) / 2;

    for (let i = 0; i < digits.length; i++) {
        const offset = start + i * spacing;
        const digit = digits.charCodeAt(i) - 48;

        spawnSafe(dimension, `replay_director:keyframe_digit_${digit}`, {
            x: location.x + rightX * offset,
            y: location.y + 0.18,
            z: location.z + rightZ * offset
        });
    }
}

function spawnSafe(dimension, particleId, location) {
    try {
        dimension.spawnParticle(particleId, location);
    } catch (e) {
        // Fail soft: an unloaded chunk must never kill the visualization loop.
    }
}
