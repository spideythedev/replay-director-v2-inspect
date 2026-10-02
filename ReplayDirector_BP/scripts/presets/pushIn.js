/**
 * Replay Director - Preset: Push In
 *
 * Classic dolly-in: camera starts far back facing the subject and glides
 * straight toward them, ending close for a dramatic finish.
 */

import { DISTANCE_METERS, HEIGHT_OFFSET, pointOnCircle } from "./presetUtils.js";

export const PUSH_IN = {
    id: "push_in",
    name: "Push In",
    description: "Dramatic dolly-in from far away to a close-up.",
    defaultOptions: {
        durationTicks: 120,
        distance: "far",
        height: "eye",
        easing: "ease_out"
    },
    generate(subject, opts) {
        const startRadius = DISTANCE_METERS[opts.distance] ?? DISTANCE_METERS.far;
        const endRadius = Math.max(1.5, startRadius * 0.2);
        const heightOffset = HEIGHT_OFFSET[opts.height] ?? HEIGHT_OFFSET.eye;
        const angle = subject.yaw; 

        return (t) => {
            const radius = startRadius + (endRadius - startRadius) * t;
            const location = pointOnCircle(subject.location, radius, angle, subject.headLocation.y + heightOffset - subject.location.y);
            return {
                location,
                facingLocation: subject.headLocation
            };
        };
    }
};
