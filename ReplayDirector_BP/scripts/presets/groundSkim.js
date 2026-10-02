/**
 * Replay Director - Preset: Ground Skim
 *
 * A low fly-by that travels from behind the subject toward the front while
 * sweeping across the line of sight. It is deliberately lower and faster
 * than Hero Shot, giving it a distinct action-camera feel.
 */
import { DISTANCE_METERS, pointOnCircle } from "./presetUtils.js";

export const GROUND_SKIM = {
    id: "ground_skim",
    name: "Ground Skim",
    description: "Low, fast fly-by that sweeps past the subject at ground level.",
    sway: false,
    defaultOptions: {
        durationTicks: 95,
        distance: "far",
        height: "low",
        easing: "ease_in_out"
    },
    generate(subject, opts) {
        const radius = DISTANCE_METERS[opts.distance] ?? DISTANCE_METERS.far;
        const startAngle = subject.yaw + 205;
        const endAngle = subject.yaw + 25;
        const yOffset = 0.35;

        return (t) => {
            const angle = startAngle + (endAngle - startAngle) * t;
            const nearGround = yOffset + 0.25 * Math.sin(Math.PI * t);
            const location = pointOnCircle(subject.location, radius, angle, nearGround);
            return {
                location,
                facingLocation: subject.headLocation
            };
        };
    }
};
