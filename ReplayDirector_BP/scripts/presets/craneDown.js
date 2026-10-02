import { DISTANCE_METERS, pointOnCircle } from "./presetUtils.js";

export const CRANE_DOWN = {
    id: "crane_down",
    name: "Crane Down",
    description: "Camera descends from a high overhead view down to eye level on the subject.",
    defaultOptions: { durationTicks: 130, distance: "medium", height: "eye", easing: "ease_in_out" },
    generate(subject, opts) {
        const radius = DISTANCE_METERS[opts.distance] ?? DISTANCE_METERS.medium;
        const startY = 14;
        const endY = subject.headLocation.y - subject.location.y;
        const angle = subject.yaw;
        return (t) => {
            const yOffset = startY + (endY - startY) * t;
            const location = pointOnCircle(subject.location, radius, angle, yOffset);
            return { location, facingLocation: subject.headLocation };
        };
    }
};
