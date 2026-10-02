import { DISTANCE_METERS, HEIGHT_OFFSET, pointOnCircle } from "./presetUtils.js";

export const PULL_OUT = {
    id: "pull_out",
    name: "Pull Out",
    description: "Reveal shot: camera starts close on the subject and glides back to a wide view.",
    defaultOptions: { durationTicks: 120, distance: "far", height: "eye", easing: "ease_in" },
    generate(subject, opts) {
        const endRadius = DISTANCE_METERS[opts.distance] ?? DISTANCE_METERS.far;
        const startRadius = Math.max(1.5, endRadius * 0.2);
        const heightOffset = HEIGHT_OFFSET[opts.height] ?? HEIGHT_OFFSET.eye;
        const angle = subject.yaw;
        return (t) => {
            const radius = startRadius + (endRadius - startRadius) * t;
            const location = pointOnCircle(subject.location, radius, angle, subject.headLocation.y + heightOffset - subject.location.y);
            return { location, facingLocation: subject.headLocation };
        };
    }
};
