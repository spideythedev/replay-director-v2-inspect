import { DISTANCE_METERS, pointOnCircle } from "./presetUtils.js";

export const LOW_ANGLE = {
    id: "low_angle",
    name: "Low Angle",
    description: "Static-feeling low shot looking sharply up at the subject - makes them look powerful.",
    defaultOptions: { durationTicks: 100, distance: "near", height: "low", easing: "ease_out" },
    generate(subject, opts) {
        const startRadius = (DISTANCE_METERS[opts.distance] ?? DISTANCE_METERS.near) * 1.6;
        const endRadius = DISTANCE_METERS[opts.distance] ?? DISTANCE_METERS.near;
        const yOffset = subject.headLocation.y - subject.location.y - 1.6; // well below eye level
        const angle = subject.yaw;
        return (t) => {
            const radius = startRadius + (endRadius - startRadius) * t;
            const location = pointOnCircle(subject.location, radius, angle, yOffset);
            return { location, facingLocation: subject.headLocation };
        };
    }
};
