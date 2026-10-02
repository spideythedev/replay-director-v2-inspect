/**
 * Replay Director - Director Stick Identity
 *
 * Every Director tool (the main menu stick and the 7 in-playback sticks)
 * is a plain, unmodified vanilla minecraft:stick, told apart only by its
 * ItemStack.nameTag - a real, documented ItemStack property. There is no
 * custom item JSON anywhere in this add-on and no custom component
 * registration; a stick is just a stick with a name.
 *
 * This file is the single source of truth for those name strings and for
 * building a correctly-named stick ItemStack, so main.js (which detects a
 * use by nameTag) and viewingMode.js (which gives/removes the 7 in-
 * playback sticks) can't drift out of sync with each other.
 */

import { ItemStack } from "@minecraft/server";

/** nameTag of the main menu-opening stick - the one a director manually carries to open the full menu, separate from the 7 in-playback sticks below. */
export const MAIN_STICK_NAME = "§6§lReplay Director";

/** nameTag of each in-playback Director Stick, keyed by function. Every one of these is given/removed automatically by viewingMode.js during playback - a player is never expected to source these themselves. */
export const STICK_NAMES = {
    pause: "§e§lPause / Resume",
    speed: "§b§lPlayback Speed",
    presets: "§d§lCamera Presets",
    keyframe: "§a§lAdd Keyframe",
    timeline: "§3§lTimeline",
    gamemode: "§9§lGamemode",
    stop: "§c§lStop Replay",
    skinCycle: "§5§lActor Skin"
};

/** @returns {import("@minecraft/server").ItemStack} a fresh vanilla stick with the given nameTag. */
export function createDirectorToolStick(nameTag, keepOnDeath = false) {
    const stack = new ItemStack("minecraft:stick", 1);
    stack.nameTag = nameTag;
    // Make the director tool a distinct, non-stack-collapsing utility item and
    // preserve it through normal Survival deaths. Hardcore has no respawn, but
    // this also makes the behavior consistent across supported modes.
    stack.setLore(["§8Replay Director • Cinematic Tool"]);
    if (keepOnDeath) stack.keepOnDeath = true;
    return stack;
}
