import { DISTANCE_METERS, HEIGHT_OFFSET, pointOnCircle } from "./presetUtils.js";

export const ORBIT_RIGHT = {
    id: "orbit_right",
    name: "Orbit Right",
    description: "Smooth 360-degree orbit around the subject (clockwise).",
    defaultOptions: { durationTicks: 160, distance: "medium", height: "eye", easing: "linear" },
    generate(subject, opts) {
        const radius = DISTANCE_METERS[opts.distance] ?? DISTANCE_METERS.medium;
        const heightOffset = HEIGHT_OFFSET[opts.height] ?? HEIGHT_OFFSET.eye;
        const startAngle = subject.yaw;
        return (t) => {
            const angle = startAngle + 360 * t; // positive = clockwise ("right")
            const location = pointOnCircle(subject.location, radius, angle, subject.headLocation.y + heightOffset - subject.location.y);
            return { location, facingLocation: subject.headLocation };
        };
    }
};
