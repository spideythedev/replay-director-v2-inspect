import { premiumSection, premiumActive, premiumDisabled, premiumPrimary, premiumSecondary, premiumDanger, premiumBack, premiumLabel, premiumBody } from "./theme.js";
/**
 * Replay Director - Replay List (Phase 3B)
 */

import { ActionFormData } from "@minecraft/server-ui";
import { listReplays } from "../replay/storage.js";
import { getPlayingReplayId } from "../replay/playback.js";
import { openReplayMenu } from "./replayMenu.js";
import { openReplayDetailMenu } from "./replayDetailMenu.js";

/**
 * @param {import("@minecraft/server").Player} player
 */
export async function openReplayListMenu(player) {
    const replays = listReplays();
    const playingReplayId = getPlayingReplayId();
    const form = new ActionFormData()
        .title("§6§lReplay List")
        .body(replays.length === 0 ? "§7No saved replays yet - record something first." : "§7Select a replay.");

    for (const record of replays) {
        const seconds = (record.frameCount / 20).toFixed(1);
        const active = record.id === playingReplayId;
        form.button(`${active ? "§a● " : "§b"}${record.name}\n§r§8${seconds}s • ${record.playerCount} player(s)${active ? " • §aPLAYING" : ""}`);
    }
    form.button("§3« Back");

    premiumSection(form, "REPLAY LIBRARY", "Replay List");
    const response = await form.show(player);
    if (response.canceled) return;

    if (response.selection === replays.length) {
        return openReplayMenu(player);
    }

    return openReplayDetailMenu(player, replays[response.selection].id);
}
