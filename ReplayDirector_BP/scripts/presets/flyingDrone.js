/**
 * Replay Director - Preset: Flying Drone
 *
 * A continuous orbit with constantly shifting altitude - like a real drone
 * operator can't hold perfectly still, the height drifts up and down in a
 * layered, non-repeating-feeling wave while smoothly circling the subject.
 */

import { DISTANCE_METERS, HEIGHT_OFFSET, pointOnCircle } from "./presetUtils.js";

export const FLYING_DRONE = {
    id: "flying_drone",
    name: "Flying Drone",
    description: "Smooth orbiting drone shot with constantly shifting height.",
    defaultOptions: {
        durationTicks: 200,
        distance: "medium",
        height: "high",
        easing: "linear"
    },
    generate(subject, opts) {
        const radius = DISTANCE_METERS[opts.distance] ?? DISTANCE_METERS.medium;
        const baseHeight = HEIGHT_OFFSET[opts.height] ?? HEIGHT_OFFSET.high;
        const startAngle = subject.yaw;

        return (t) => {
            const angle = startAngle + 360 * t; // one full lap over the shot
            // Two layered sine waves at different speeds/phases so the
            // altitude drift feels organic rather than a simple bob.
            const heightWobble = Math.sin(t * Math.PI * 3.3) * 1.6 + Math.sin(t * Math.PI * 1.1 + 1.0) * 0.9;
            const location = pointOnCircle(
                subject.location,
                radius,
                angle,
                subject.headLocation.y + baseHeight + heightWobble - subject.location.y
            );
            return {
                location,
                facingLocation: subject.headLocation
            };
        };
    }
};
