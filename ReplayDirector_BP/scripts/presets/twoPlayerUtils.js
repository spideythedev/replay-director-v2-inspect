
import { world } from "@minecraft/server";

export function getTwoPlayerPair(director) {
    if (!director || !director.isValid) return undefined;
    const others = world.getAllPlayers()
        .filter((p) => p.isValid && p.id !== director.id)
        .sort((a, b) => {
            const da = Math.hypot(a.location.x - director.location.x, a.location.y - director.location.y, a.location.z - director.location.z);
            const db = Math.hypot(b.location.x - director.location.x, b.location.y - director.location.y, b.location.z - director.location.z);
            return da - db;
        });
    if (!others.length) return undefined;
    return { main: director, opponent: others[0] };
}

export function twoPlayerSnapshot(director) {
    const pair = getTwoPlayerPair(director);
    if (!pair) return undefined;
    return {
        main: {
            location: { ...pair.main.location },
            headLocation: { ...pair.main.getHeadLocation() },
            yaw: pair.main.getRotation().y
        },
        opponent: {
            location: { ...pair.opponent.location },
            headLocation: { ...pair.opponent.getHeadLocation() },
            yaw: pair.opponent.getRotation().y
        }
    };
}

export function normalize2D(x, z) {
    const length = Math.hypot(x, z) || 1;
    return { x: x / length, z: z / length };
}

export function lerpPoint(a, b, t) {
    return {
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        z: a.z + (b.z - a.z) * t
    };
}
