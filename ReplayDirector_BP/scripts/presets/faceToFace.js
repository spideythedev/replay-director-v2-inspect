import { getTwoPlayerPair, lerpPoint, normalize2D } from "./twoPlayerUtils.js";
import { DISTANCE_METERS, HEIGHT_OFFSET } from "./presetUtils.js";

export const FACE_TO_FACE = {
    id: "face_to_face",
    name: "Face-to-Face",
    description: "Balanced two-shot that keeps both characters readable in the same frame.",
    requiresTwoPlayers: true,
    defaultOptions: { durationTicks: 100, distance: "far", height: "eye", easing: "ease_in_out" },
    generate(subject, opts, dimension, director) {
        const pair = getTwoPlayerPair(director);
        if (!pair) return () => ({ location: subject.headLocation, facingLocation: subject.headLocation });
        const a = pair.main.getHeadLocation(), b = pair.opponent.getHeadLocation();
        const mid = lerpPoint(a,b,0.5);
        const f = normalize2D(b.x-a.x,b.z-a.z);
        const side = { x: -f.z, z: f.x };
        const radius = DISTANCE_METERS[opts.distance] ?? DISTANCE_METERS.far;
        const cam = {
            x: mid.x + side.x * radius,
            y: mid.y + (HEIGHT_OFFSET[opts.height] ?? 0),
            z: mid.z + side.z * radius
        };
        return () => ({ location: cam, facingLocation: mid });
    }
};
