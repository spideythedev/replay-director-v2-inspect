import { premiumSection, premiumActive, premiumDisabled, premiumPrimary, premiumSecondary, premiumDanger, premiumBack, premiumLabel, premiumBody } from "./theme.js";
/**
 * Replay Director - Director Controls (stabilization pass)
 *
 * Reached from Timeline while a replay is playing. Offers the same
 * Cinematic Presets and Manual Camera systems used everywhere else -
 * nothing new is built here, this is just a doorway into them for the
 * "control the camera while a replay runs" workflow.
 *
 * Named "Director Controls" rather than "Replay Editor" deliberately -
 * "Edit Replay" already means something different in this addon (actor
 * skin/name settings on a saved replay, reached from Replay Detail).
 * Reusing that name for a different screen would be confusing, so this
 * one has its own name even though it fills the role your flow called
 * "Replay Editor".
 *
 * Both Presets and Manual Camera already work during playback without
 * pausing/freezing it - Presets' "Replay Actor" focus mode never freezes
 * its subject (Phase 3G), and Manual Camera never touches playback state
 * at all (Phase 3H) - so no changes were needed to either system for this
 * screen to exist.
 */

import { ActionFormData } from "@minecraft/server-ui";
import { isPlaying, getPlayingReplayId } from "../replay/playback.js";
import { openPresetsMenu, openLastPreset } from "./presetsMenu.js";
import { openManualCameraMenu } from "./manualCameraMenu.js";
import { openTimelineMenu } from "./timelineMenu.js";
import { openKeyframeMenu } from "./keyframeMenu.js";
import { getPath } from "../manualCamera/pathState.js";
import { getLastPreset } from "./presetsMenu.js";

/**
 * @param {import("@minecraft/server").Player} player
 * @param {{standalone?: boolean}} [opts] - kept for call-site compatibility (stick entry points still pass this) but no longer changes behavior here: X/Escape always just closes the menu now, and the labeled "« Back to Timeline" button always navigates, regardless of how this screen was reached.
 */
export async function openDirectorControlsMenu(player, opts = {}) {
    if (!isPlaying()) {
        player.sendMessage("§7Nothing is playing right now.");
        return openTimelineMenu(player);
    }

    // Keyframes are scoped per-replay now - this must reflect THIS replay's
    // count, not any other replay's path the director may have built earlier.
    const keyframeCount = getPath(player.id, getPlayingReplayId()).keyframes.length;

    const form = new ActionFormData()
        .title("§6§lDirector Controls")
        .body("§7Control the camera while the replay keeps playing in the background. Switch freely between Presets, Manual Camera, and Keyframes.")
        .button("§3Cinematic Presets")
        .button(getLastPreset(player.id) ? `§6⚡ Last Preset: ${getLastPreset(player.id).presetName}` : "§8Last Preset (none yet)")
        .button("§3Manual Camera")
        .button(keyframeCount > 0 ? "§3Keyframes" : "§8Keyframes (none yet)")
        .button("§3« Back to Timeline");

    premiumSection(form, "DIRECTOR CONTROLS", "Director Controls");
    const response = await form.show(player);
    if (response.canceled) return;

    switch (response.selection) {
        case 0:
            return openPresetsMenu(player);
        case 1: {
            const last = getLastPreset(player.id);
            if (!last) return openDirectorControlsMenu(player, opts);
            return openLastPreset(player, last);
        }
        case 2:
            return openManualCameraMenu(player);
        case 3:
            if (keyframeCount === 0) return openDirectorControlsMenu(player, opts);
            return openKeyframeMenu(player);
        case 4:
            return openTimelineMenu(player);
    }
}
