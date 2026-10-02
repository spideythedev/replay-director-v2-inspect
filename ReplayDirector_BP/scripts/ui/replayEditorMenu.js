import { premiumSection, premiumActive, premiumDisabled, premiumPrimary, premiumSecondary, premiumDanger, premiumBack, premiumLabel, premiumBody } from "./theme.js";
/**
 * Replay Director - Replay Editor (Phase 3B)
 *
 * Where replay-specific editing lives. Today that's just picking each
 * actor to edit; Replay Actor itself only has Skin working right now,
 * with Name/Armor/Held Item/Visibility as clearly-marked future slots.
 */

import { ActionFormData } from "@minecraft/server-ui";
import { getReplay } from "../replay/storage.js";
import { getSkinById } from "../core/replaySkins.js";
import { openReplayDetailMenu } from "./replayDetailMenu.js";
import { openReplayActorMenu } from "./replayActorMenu.js";

/**
 * @param {import("@minecraft/server").Player} player
 * @param {string} replayId
 */
export async function openReplayEditorMenu(player, replayId) {
    const record = getReplay(replayId);
    if (!record) {
        player.sendMessage("§cThat replay no longer exists.");
        return openReplayDetailMenu(player, replayId);
    }

    const form = new ActionFormData()
        .title(`§6Edit: ${record.name}`)
        .body("§7Select a replay actor to edit their skin (and later name/armor/held item/visibility).");

    for (const actor of record.actors) {
        const skin = getSkinById(actor.skinId);
        form.button(`§3${actor.displayName}\n§r§8Skin: ${skin ? skin.name : "none"}`);
    }
    form.button("§3« Back");

    premiumSection(form, "REPLAY EDITOR", "Edit Replay");
    const response = await form.show(player);
    if (response.canceled) return;

    if (response.selection === record.actors.length) {
        return openReplayDetailMenu(player, replayId);
    }

    const actor = record.actors[response.selection];
    return openReplayActorMenu(player, replayId, actor.playerId);
}
