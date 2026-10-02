import { DISTANCE_METERS, pointOnCircle } from "./presetUtils.js";

export const HIGH_ANGLE = {
    id: "high_angle",
    name: "High Angle",
    description: "Shot looking down at the subject from above - makes them look small/vulnerable.",
    defaultOptions: { durationTicks: 100, distance: "medium", height: "high", easing: "ease_out" },
    generate(subject, opts) {
        const radius = DISTANCE_METERS[opts.distance] ?? DISTANCE_METERS.medium;
        const yOffset = subject.headLocation.y - subject.location.y + 5;
        const startAngle = subject.yaw - 20;
        const endAngle = subject.yaw + 20;
        return (t) => {
            const angle = startAngle + (endAngle - startAngle) * t;
            const location = pointOnCircle(subject.location, radius, angle, yOffset);
            return { location, facingLocation: subject.headLocation };
        };
    }
};
