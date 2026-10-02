import { premiumSection, premiumActive, premiumDisabled, premiumPrimary, premiumSecondary, premiumDanger, premiumBack, premiumLabel, premiumBody } from "./theme.js";
/**
 * Replay Director - Stub Menu
 *
 * Placeholder for sections not yet built (Replay, Camera, Timeline,
 * Settings). Keeps the full menu tree navigable from Phase 1 so later
 * phases just swap this out for the real screen.
 */

import { ActionFormData } from "@minecraft/server-ui";
import { openMainMenu } from "./mainMenu.js";

/**
 * @param {import("@minecraft/server").Player} player
 * @param {string} title
 * @param {string} message
 */
export async function openStubMenu(player, title, message) {
    const form = new ActionFormData()
        .title(`§6§l${title}`)
        .body(`§7${message}`)
        .button("§3« Back");

    premiumSection(form, "INFORMATION", "Replay Director");
    const response = await form.show(player);
    return openMainMenu(player);
}
