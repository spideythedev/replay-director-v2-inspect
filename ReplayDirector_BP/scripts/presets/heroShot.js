/**
 * Replay Director - Preset: Hero Shot
 *
 * A classic low, slightly-arcing shot facing the subject - the addon's
 * "hello world" cinematic. Camera sits low in front of the subject and
 * drifts a few degrees across the shot while looking up at them.
 */

import { DISTANCE_METERS, HEIGHT_OFFSET, pointOnCircle } from "./presetUtils.js";

export const HERO_SHOT = {
    id: "hero_shot",
    name: "Hero Shot",
    description: "Low, powerful shot looking up at the subject with a subtle arc.",
    defaultOptions: {
        durationTicks: 100,
        distance: "medium",
        height: "low",
        easing: "ease_in_out"
    },
    /**
     * @param {import("@minecraft/server").Player} target
     * @param {{distance:string, height:string}} opts
     */
    generate(subject, opts) {
        const radius = DISTANCE_METERS[opts.distance] ?? DISTANCE_METERS.medium;
        const heightOffset = HEIGHT_OFFSET[opts.height] ?? HEIGHT_OFFSET.low;
        const startAngle = subject.yaw - 12; // in front of subject's face, offset left
        const endAngle = subject.yaw + 12;

        return (t) => {
            const angle = startAngle + (endAngle - startAngle) * t;
            const location = pointOnCircle(subject.location, radius, angle, subject.headLocation.y + heightOffset - subject.location.y);
            return {
                location,
                facingLocation: subject.headLocation
            };
        };
    }
};
