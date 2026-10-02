/**
 * Replay Director - Preset: Reverse Dolly
 *
 * Camera retreats from a close-up to a wide view like Pull Out, but drifts
 * sideways across the shot too, so it reads as a distinct dramatic reveal
 * rather than a plain straight-back pull.
 */

import { DISTANCE_METERS, HEIGHT_OFFSET, pointOnCircle } from "./presetUtils.js";

export const REVERSE_DOLLY = {
    id: "reverse_dolly",
    name: "Reverse Dolly",
    description: "Camera retreats from close-up to wide while drifting sideways for a dramatic reveal.",
    defaultOptions: { durationTicks: 120, distance: "far", height: "eye", easing: "ease_out" },
    generate(subject, opts) {
        const endRadius = DISTANCE_METERS[opts.distance] ?? DISTANCE_METERS.far;
        const startRadius = Math.max(1.5, endRadius * 0.25);
        const heightOffset = HEIGHT_OFFSET[opts.height] ?? HEIGHT_OFFSET.eye;
        const startAngle = subject.yaw - 25;
        const endAngle = subject.yaw + 5;

        return (t) => {
            const radius = startRadius + (endRadius - startRadius) * t;
            const angle = startAngle + (endAngle - startAngle) * t;
            const location = pointOnCircle(subject.location, radius, angle, subject.headLocation.y + heightOffset - subject.location.y);
            return {
                location,
                facingLocation: subject.headLocation
            };
        };
    }
};
