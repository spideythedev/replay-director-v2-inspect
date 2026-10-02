import { DISTANCE_METERS, pointOnCircle } from "./presetUtils.js";

export const CRANE_UP = {
    id: "crane_up",
    name: "Crane Up",
    description: "Camera rises from eye level up to a high overhead view while staying on the subject.",
    defaultOptions: { durationTicks: 130, distance: "medium", height: "eye", easing: "ease_in_out" },
    generate(subject, opts) {
        const radius = DISTANCE_METERS[opts.distance] ?? DISTANCE_METERS.medium;
        const startY = subject.headLocation.y - subject.location.y;
        const endY = 14;
        const angle = subject.yaw;
        return (t) => {
            const yOffset = startY + (endY - startY) * t;
            const location = pointOnCircle(subject.location, radius, angle, yOffset);
            return { location, facingLocation: subject.headLocation };
        };
    }
};
