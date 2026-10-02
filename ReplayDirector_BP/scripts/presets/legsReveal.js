import { getTwoPlayerPair, normalize2D } from "./twoPlayerUtils.js";
import { DISTANCE_METERS, HEIGHT_OFFSET } from "./presetUtils.js";

export const LEGS_REVEAL = {
    id: "legs_reveal",
    name: "Legs Reveal",
    description: "Low camera behind the foreground character's legs, framing the opponent ahead.",
    requiresTwoPlayers: true,
    defaultOptions: { durationTicks: 100, distance: "near", height: "low", easing: "linear" },
    generate(subject, opts, dimension, director) {
        const pair = getTwoPlayerPair(director);
        if (!pair) return () => ({ location: subject.location, facingLocation: subject.headLocation });
        const main = pair.main, opponent = pair.opponent;
        const f = normalize2D(opponent.location.x-main.location.x, opponent.location.z-main.location.z);
        const radius = Math.max(2.4, (DISTANCE_METERS[opts.distance] ?? 3) * 0.9);
        const cam = {
            x: main.location.x - f.x * radius,
            y: main.location.y + 0.45 + (HEIGHT_OFFSET[opts.height] ?? -0.6) * 0.25,
            z: main.location.z - f.z * radius
        };
        return (t) => ({
            location: cam,
            facingLocation: {
                x: opponent.getHeadLocation().x,
                y: opponent.getHeadLocation().y - 0.1,
                z: opponent.getHeadLocation().z
            },
            fov: 50
        });
    }
};
