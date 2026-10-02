/**
 * Replay Director - Camera Shake
 *
 * Thin wrapper around the vanilla /camerashake command so shake works on
 * a player's normal view too, not just during a cinematic. shake_type is
 * "positional" (a jolt/offset shake) or "rotational" (a rotation wobble).
 *
 * IMPORTANT: /camerashake only produces a visible effect if the player has
 * "Camera Shake" enabled in their own Minecraft Accessibility settings -
 * that's a client-side toggle this addon cannot see or override.
 *
 * Reaction-style presets (Explosion, Landing, Punch, Bow) are a single
 * pulse and stop on their own, matching their real-world duration. The
 * more ambient ones (Sprint, Earthquake, Boss Fight) are marked `loop`
 * and re-trigger themselves just before the previous pulse ends, so they
 * keep going until Stop Shake is pressed instead of cutting out after
 * one short burst.
 */

import { system } from "@minecraft/server";

export const SHAKE_PRESETS = [
    { id: "explosion", name: "Explosion", intensity: 0.9, seconds: 0.6, type: "positional", loop: false },
    { id: "sprint", name: "Sprint", intensity: 0.15, seconds: 1.0, type: "positional", loop: true },
    { id: "landing", name: "Landing", intensity: 0.4, seconds: 0.3, type: "positional", loop: false },
    { id: "punch", name: "Punch", intensity: 0.35, seconds: 0.25, type: "rotational", loop: false },
    { id: "bow", name: "Bow", intensity: 0.2, seconds: 0.35, type: "rotational", loop: false },
    { id: "earthquake", name: "Earthquake", intensity: 0.5, seconds: 3.0, type: "positional", loop: true },
    { id: "boss_fight", name: "Boss Fight", intensity: 0.6, seconds: 1.5, type: "positional", loop: true }
];

/** @type {Map<string, number>} playerId -> active system.runInterval id */
const activeLoops = new Map();

export function getShakePresetById(id) {
    return SHAKE_PRESETS.find((p) => p.id === id);
}

/**
 * @param {import("@minecraft/server").Player} player
 * @param {{intensity:number, seconds:number, type:string, loop:boolean}} preset
 */
export function playShake(player, preset) {
    stopLoop(player.id);
    triggerOnce(player, preset);

    if (preset.loop) {
        // Re-trigger slightly before the current pulse would end, so there's
        // no visible gap/flicker between repeats.
        const intervalTicks = Math.max(2, Math.round((preset.seconds - 0.05) * 20));
        const id = system.runInterval(() => {
            if (!player.isValid) {
                stopLoop(player.id);
                return;
            }
            triggerOnce(player, preset);
        }, intervalTicks);
        activeLoops.set(player.id, id);
    }
}

/** @param {import("@minecraft/server").Player} player */
export function stopShake(player) {
    stopLoop(player.id);
    try {
        player.runCommand("camerashake stop @s");
    } catch (e) {
        // fail soft
    }
}

function triggerOnce(player, preset) {
    try {
        player.runCommand(`camerashake add @s ${preset.intensity} ${preset.seconds} ${preset.type}`);
    } catch (e) {
        // fail soft
    }
}

function stopLoop(playerId) {
    const id = activeLoops.get(playerId);
    if (id !== undefined) {
        system.clearRun(id);
        activeLoops.delete(playerId);
    }
}
