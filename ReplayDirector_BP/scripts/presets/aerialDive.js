/**
 * Replay Director - Preset: Aerial Dive
 *
 * Starts high and wide, then dives toward the subject while rotating around
 * them. It combines vertical descent with a controlled arc, distinct from
 * Bird's Eye (mostly static overhead framing) and Spiral Orbit (multi-turn
 * corkscrew).
 */
import { DISTANCE_METERS, pointOnCircle } from "./presetUtils.js";

export const AERIAL_DIVE = {
    id: "aerial_dive",
    name: "Aerial Dive",
    description: "High-to-low diving arc that closes rapidly on the subject.",
    sway: false,
    defaultOptions: {
        durationTicks: 125,
        distance: "far",
        height: "very_high",
        easing: "ease_in_out"
    },
    generate(subject, opts) {
        const endRadius = DISTANCE_METERS[opts.distance] ?? DISTANCE_METERS.far;
        const startRadius = endRadius * 1.35;
        const startHeight = 9 + (opts.height === "very_high" ? 2 : 0);
        const endHeight = 0.8;
        const startAngle = subject.yaw - 155;
        const endAngle = subject.yaw - 35;

        return (t) => {
            const dive = t * t * (3 - 2 * t);
            const radius = startRadius + (endRadius - startRadius) * dive;
            const yOffset = startHeight + (endHeight - startHeight) * dive;
            const angle = startAngle + (endAngle - startAngle) * t;
            const location = pointOnCircle(subject.location, radius, angle, yOffset);
            return {
                location,
                facingLocation: subject.headLocation
            };
        };
    }
};
