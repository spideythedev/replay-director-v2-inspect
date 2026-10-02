/**
 * Replay Director - Preset: Snap Orbit
 *
 * A compact 180-degree orbit with a slight rise. Unlike the full Orbit
 * presets, this is a single fast half-orbit intended for an energetic
 * reveal or transition between two sides of the subject.
 */
import { DISTANCE_METERS, HEIGHT_OFFSET, pointOnCircle } from "./presetUtils.js";

export const SNAP_ORBIT = {
    id: "snap_orbit",
    name: "Snap Orbit",
    description: "Fast 180-degree orbit with a subtle rise around the subject.",
    defaultOptions: {
        durationTicks: 90,
        distance: "medium",
        height: "eye",
        easing: "ease_in_out"
    },
    generate(subject, opts) {
        const radius = DISTANCE_METERS[opts.distance] ?? DISTANCE_METERS.medium;
        const baseHeight = HEIGHT_OFFSET[opts.height] ?? HEIGHT_OFFSET.eye;
        const startAngle = subject.yaw - 90;

        return (t) => {
            const angle = startAngle + 180 * t;
            const yOffset = baseHeight + 1.2 * t;
            const location = pointOnCircle(
                subject.location,
                radius,
                angle,
                subject.headLocation.y + yOffset - subject.location.y
            );
            return {
                location,
                facingLocation: subject.headLocation
            };
        };
    }
};
