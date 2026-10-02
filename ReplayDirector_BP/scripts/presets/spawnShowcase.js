/**
 * Replay Director - Spawn Showcase
 *
 * A location-based cinematic (not player-based) that tours the world's
 * spawn point as one continuous sequence: Orbit -> Bird's Eye -> Ground
 * Level -> Hero Shot. Reuses the existing preset shot math directly
 * against a virtual "subject" built from the spawn coordinates.
 */

import { world } from "@minecraft/server";
import { playSequence } from "../camera/cameraRunner.js";
import { isCountdownEnabled } from "../core/settings.js";
import { ORBIT_LEFT } from "./orbitLeft.js";
import { BIRDS_EYE } from "./birdsEye.js";
import { LOW_ANGLE } from "./lowAngle.js";
import { HERO_SHOT } from "./heroShot.js";

const EYE_HEIGHT = 1.62;

/** Finds the topmost solid block at (x,z) - the raw spawn Y is often 32767 (unset) and unusable directly. */
function findGroundY(dimension, x, z) {
    for (let y = 320; y >= -64; y--) {
        let block;
        try {
            block = dimension.getBlock({ x, y, z });
        } catch (e) {
            continue;
        }
        if (!block) continue;
        if (!block.isAir && !block.isLiquid) return y + 1;
    }
    return undefined;
}

function buildSpawnSubject(dimension) {
    const spawn = world.getDefaultSpawnLocation();
    let y = spawn.y;
    if (!(y > -64 && y < 320)) {
        y = findGroundY(dimension, Math.floor(spawn.x), Math.floor(spawn.z)) ?? 64;
    }
    const location = { x: spawn.x, y, z: spawn.z };
    const headLocation = { x: spawn.x, y: y + EYE_HEIGHT, z: spawn.z };
    return { location, headLocation, yaw: 0 };
}

function toSegment(preset, subject, opts, durationTicks) {
    return {
        durationTicks,
        easing: preset.defaultOptions.easing,
        shotFn: preset.generate(subject, opts)
    };
}

/**
 * @param {import("@minecraft/server").Player} director
 */
export async function runSpawnShowcase(director) {
    const dimension = director.dimension;
    const subject = buildSpawnSubject(dimension);

    const segments = [
        toSegment(ORBIT_LEFT, subject, { distance: "far", height: "high" }, 160),
        toSegment(BIRDS_EYE, subject, { distance: "far", height: "very_high" }, 160),
        toSegment(LOW_ANGLE, subject, { distance: "near", height: "low" }, 100),
        toSegment(HERO_SHOT, subject, { distance: "medium", height: "low" }, 120)
    ];

    director.sendMessage("§a▶ Running §bSpawn Showcase§a...");

    await playSequence(director, {
        segments,
        countdown: isCountdownEnabled(),
        freezeSubject: false,
        subject: undefined,
        disableCollision: true,
        onComplete: () => {
            if (director.isValid) {
                director.sendMessage("§a✔ Spawn Showcase finished.");
            }
        }
    });
}
