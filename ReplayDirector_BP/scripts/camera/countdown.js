/**
 * Replay Director - Countdown
 *
 * Shows a 3-2-1-GO title sequence to the director before a cinematic starts.
 * Resolves the returned Promise once the countdown finishes, or resolves
 * immediately if countdown is disabled.
 */

import { system } from "@minecraft/server";

/**
 * @param {import("@minecraft/server").Player} player
 * @param {boolean} enabled
 * @returns {Promise<void>}
 */
export function runCountdown(player, enabled) {
    if (!enabled) return Promise.resolve();

    const steps = ["§e3", "§63", "§62", "§c1", "§a§lGO!"];
    // Simplify: 3, 2, 1, GO (4 beats, 1 beat = 15 ticks)
    const beats = ["§e§l3", "§6§l2", "§c§l1", "§a§lGO!"];
    const ticksPerBeat = 15;

    return new Promise((resolve) => {
        let i = 0;
        const showNext = () => {
            if (!player.isValid) {
                resolve();
                return;
            }
            if (i >= beats.length) {
                resolve();
                return;
            }
            player.onScreenDisplay.setTitle(beats[i], {
                fadeInDuration: 0,
                stayDuration: ticksPerBeat,
                fadeOutDuration: 2
            });
            player.playSound(i < beats.length - 1 ? "note.hat" : "note.pling", { pitch: i < beats.length - 1 ? 1.0 : 1.5 });
            i++;
            system.runTimeout(showNext, ticksPerBeat);
        };
        showNext();
    });
}
