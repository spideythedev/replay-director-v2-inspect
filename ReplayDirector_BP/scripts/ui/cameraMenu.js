import { premiumSection, premiumActive, premiumDisabled, premiumPrimary, premiumSecondary, premiumDanger, premiumBack, premiumLabel, premiumBody } from "./theme.js";
/**
 * Replay Director - Camera Menu
 *
 * Camera shake presets, playable any time (not just during a cinematic).
 * Manual Camera Mode lives as its own top-level category on the Main
 * Menu now, not here and not only inside Director Controls - see
 * mainMenu.js for how it's wired in both playing and standalone contexts.
 */

import { ActionFormData } from "@minecraft/server-ui";
import { SHAKE_PRESETS, playShake, stopShake } from "../camera/shake.js";
import { openMainMenu } from "./mainMenu.js";

/**
 * @param {import("@minecraft/server").Player} player
 */
export async function openCameraMenu(player) {
    const form = new ActionFormData()
        .title("§6§lCamera")
        .body("§7Camera shake presets. Trigger one any time - during a cinematic or your normal view.\n§r§8(Needs 'Camera Shake' ON in your Accessibility settings.)");

    for (const preset of SHAKE_PRESETS) {
        const tag = preset.loop ? "§8(continuous - Stop Shake to end)" : "§8(single pulse)";
        form.button(`§3${preset.name}\n${tag}`);
    }
    form.button("§4Stop Shake");
    form.button("§3« Back");

    premiumSection(form, "CAMERA", "Camera");
    const response = await form.show(player);
    if (response.canceled) return;

    if (response.selection === SHAKE_PRESETS.length) {
        stopShake(player);
        player.sendMessage("§7Camera shake stopped.");
        return openCameraMenu(player);
    }
    if (response.selection === SHAKE_PRESETS.length + 1) {
        return openMainMenu(player);
    }

    const preset = SHAKE_PRESETS[response.selection];
    playShake(player, preset);
    player.sendMessage(`§a▶ ${preset.name} shake.`);
    return openCameraMenu(player);
}
