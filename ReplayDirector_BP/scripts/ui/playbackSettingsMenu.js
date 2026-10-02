import { premiumSection, premiumActive, premiumDisabled, premiumPrimary, premiumSecondary, premiumDanger, premiumBack, premiumLabel, premiumBody } from "./theme.js";
/**
 * Replay Director - Playback Settings (Phase 3D, storage visibility added in 3I)
 *
 * Genuinely minimal for now - playback speed and actor visibility toggles
 * are later-phase features. What's here is real: stopping playback, a
 * safety net to clean up stray actors, and (Phase 3I) real storage usage
 * numbers so a creator can see if they're accumulating a lot of replays.
 */

import { ActionFormData } from "@minecraft/server-ui";
import { isPlaying, stopPlayback } from "../replay/playback.js";
import { listReplays, getStorageUsageBytes, MAX_SAVED_REPLAYS } from "../replay/storage.js";
import { openReplayMenu } from "./replayMenu.js";

/**
 * @param {import("@minecraft/server").Player} player
 */
export async function openPlaybackSettingsMenu(player) {
    const playing = isPlaying();
    const replayCount = listReplays().length;
    const storageKb = (getStorageUsageBytes() / 1024).toFixed(1);

    const form = new ActionFormData()
        .title("§6§lPlayback Settings")
        .body(
            `§7Playback speed and actor visibility toggles are coming in a later phase. For now:\n§r§8Saved replays: §9${replayCount}/${MAX_SAVED_REPLAYS}§7  Metadata storage: §9${storageKb} KB§7 (oldest auto-removed past the cap)`
        )
        .button(playing ? "§4Stop All Playback" : "§8Stop All Playback (nothing playing)")
        .button("§3Cleanup Stray Actors")
        .button("§3« Back");

    premiumSection(form, "PLAYBACK", "Playback Settings");
    const response = await form.show(player);
    if (response.canceled) return;

    switch (response.selection) {
        case 0:
            if (playing) {
                stopPlayback();
                player.sendMessage("§7■ Playback stopped.");
            } else {
                player.sendMessage("§7Nothing is currently playing.");
            }
            return openPlaybackSettingsMenu(player);
        case 1:
            try {
                player.runCommand("function replay/cleanup_actors");
            } catch (e) {
                player.sendMessage("§cCouldn't run cleanup.");
            }
            return openPlaybackSettingsMenu(player);
        case 2:
            return openReplayMenu(player);
    }
}
