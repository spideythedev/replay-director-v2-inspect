/**
 * Replay Director - Preset: Bird's Eye
 *
 * Elevated shot that slowly rotates around the subject - angled enough to
 * actually see them (not a flat straight-down silhouette), great for
 * showcasing builds/bases or a Center two-shot.
 */

import { DISTANCE_METERS, pointOnCircle } from "./presetUtils.js";

export const BIRDS_EYE = {
    id: "birds_eye",
    name: "Bird's Eye",
    description: "Elevated shot slowly rotating above/around the subject - angled, not a flat top-down.",
    defaultOptions: {
        durationTicks: 200,
        distance: "medium",
        height: "very_high",
        easing: "linear"
    },
    generate(subject, opts) {
        // A wider horizontal radius relative to height keeps this from
        // looking like a straight-down top view - it reads as "high and
        // angled" instead.
        const radius = (DISTANCE_METERS[opts.distance] ?? DISTANCE_METERS.medium) * 1.4;
        const heightAbove = 9;
        const startAngle = subject.yaw;

        return (t) => {
            const angle = startAngle + 150 * t; // slow sweeping rotation, not a full spin
            const location = pointOnCircle(subject.location, radius, angle, heightAbove);
            return {
                location,
                facingLocation: subject.headLocation
            };
        };
    }
};
