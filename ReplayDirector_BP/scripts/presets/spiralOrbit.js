/**
 * Replay Director - Preset: Spiral Orbit
 *
 * A corkscrew: the camera completes TWO full revolutions (720 degrees)
 * around the subject while descending from high above down to eye
 * level, spinning faster as it drops. This is what separates it from
 * both Orbit Left/Right (a single constant-speed revolution at fixed
 * height) and Crane Up/Down (pure vertical motion with no orbit at all)
 * - Spiral Orbit is the only preset that does sustained multi-revolution
 * circling combined with continuous vertical travel, and the only one
 * with a deliberately accelerating spin rate.
 */

import { DISTANCE_METERS, pointOnCircle } from "./presetUtils.js";

export const SPIRAL_ORBIT = {
    id: "spiral_orbit",
    name: "Spiral Orbit",
    description: "Two full corkscrewing revolutions around the subject while descending from high above to eye level, spinning faster as it drops.",
    defaultOptions: {
        durationTicks: 240,
        distance: "medium",
        height: "very_high",
        easing: "linear"
    },
    generate(subject, opts) {
        const radius = DISTANCE_METERS[opts.distance] ?? DISTANCE_METERS.medium;
        const startAngle = subject.yaw;
        const startHeight = 10;
        const endHeight = subject.headLocation.y - subject.location.y;

        return (t) => {
            // Eased spin: starts slow, speeds up - t^1.5 biases more of the
            // rotation into the back half of the shot, so the corkscrew
            // visibly accelerates as it dives, rather than spinning at a
            // flat rate throughout.
            const spinT = Math.pow(t, 1.5);
            const angle = startAngle - 720 * spinT;
            const yOffset = startHeight + (endHeight - startHeight) * t;
            const location = pointOnCircle(subject.location, radius, angle, yOffset);
            return {
                location,
                facingLocation: subject.headLocation
            };
        };
    }
};
