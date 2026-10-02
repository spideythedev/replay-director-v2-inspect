/**
 * Replay Director - Preset: Parallax Slide
 *
 * A lateral camera slide with a small forward push. The camera stays
 * roughly level and keeps the subject centered, producing a clean
 * foreground/background parallax shot rather than an orbit.
 */
import { DISTANCE_METERS, HEIGHT_OFFSET, yawVectors } from "./presetUtils.js";

export const PARALLAX_SLIDE = {
    id: "parallax_slide",
    name: "Parallax Slide",
    description: "Smooth side-to-side slide with a gentle push for strong parallax.",
    defaultOptions: {
        durationTicks: 130,
        distance: "medium",
        height: "eye",
        easing: "ease_in_out"
    },
    generate(subject, opts) {
        const distance = DISTANCE_METERS[opts.distance] ?? DISTANCE_METERS.medium;
        const height = HEIGHT_OFFSET[opts.height] ?? HEIGHT_OFFSET.eye;
        const { forward, right } = yawVectors(subject.yaw);
        const lateral = distance * 1.15;
        const depthStart = -distance * 0.35;
        const depthEnd = distance * 0.35;

        return (t) => {
            const side = -lateral + lateral * 2 * t;
            const depth = depthStart + (depthEnd - depthStart) * t;
            const location = {
                x: subject.headLocation.x + right.x * side + forward.x * depth,
                y: subject.headLocation.y + height,
                z: subject.headLocation.z + right.z * side + forward.z * depth
            };
            return {
                location,
                facingLocation: subject.headLocation
            };
        };
    }
};
