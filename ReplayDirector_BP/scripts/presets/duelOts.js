import { getTwoPlayerPair, normalize2D } from "./twoPlayerUtils.js";
import { DISTANCE_METERS, HEIGHT_OFFSET } from "./presetUtils.js";

export const DUEL_OTS = {
    id: "duel_ots",
    name: "Duel OTS",
    description: "Main character on the left third, opponent in focus ahead.",
    requiresTwoPlayers: true,
    defaultOptions: { durationTicks: 100, distance: "medium", height: "eye", easing: "linear" },
    generate(subject, opts, dimension, director) {
        const pair = getTwoPlayerPair(director);
        if (!pair) {
            return () => ({ location: subject.headLocation, facingLocation: subject.headLocation });
        }
        const main = pair.main, opponent = pair.opponent;
        const mx = opponent.location.x - main.location.x, mz = opponent.location.z - main.location.z;
        const forward = normalize2D(mx, mz);
        const right = { x: -forward.z, z: forward.x };
        const radius = DISTANCE_METERS[opts.distance] ?? DISTANCE_METERS.medium;
        const y = main.getHeadLocation().y + (HEIGHT_OFFSET[opts.height] ?? 0);
        const start = {
            x: main.location.x - forward.x * radius + right.x * (radius * 0.28),
            y,
            z: main.location.z - forward.z * radius + right.z * (radius * 0.28)
        };
        return (t) => ({
            location: start,
            facingLocation: opponent.getHeadLocation()
        });
    }
};
