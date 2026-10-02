import { premiumTitle } from "./theme.js";
/**
 * Replay Director - Main Menu
 *
 * Premium UI pass (visual only - see file-level note below for what
 * changed and, just as importantly, what deliberately did NOT).
 */

import { ActionFormData } from "@minecraft/server-ui";
import { openPresetsMenu } from "./presetsMenu.js";
import { openCameraMenu } from "./cameraMenu.js";
import { openManualCameraMenu } from "./manualCameraMenu.js";
import { openSettingsMenu } from "./settingsMenu.js";
import { openReplayMenu } from "./replayMenu.js";
import { openStubMenu } from "./stubMenu.js";

/**
 * Icon pass: the previous vanilla item paths (textures/items/clock,
 * diamond_sword, etc.) rendered as missing-texture checkerboards for
 * some players - button()'s iconPath is a raw resource-pack-relative
 * path (confirmed: this is a different mechanism from the item_texture
 * .json shortname system used by minecraft:icon on actual items), and
 * evidently not every guessed vanilla path resolves reliably through it
 * across engine versions. To remove that guesswork entirely, every icon
 * here is now a small custom PNG shipped in this RP
 * (textures/items/*_icon.png) and referenced by its exact path - no
 * dependency on vanilla item texture naming at all, so this can't break
 * the same way again.
 */
const ICON_REPLAY = "textures/items/clock_icon";
const ICON_PRESETS = "textures/items/presets_icon";
const ICON_CAMERA = "textures/items/camera_icon";
const ICON_MANUAL_CAMERA = "textures/items/manual_camera_icon";
const ICON_SETTINGS = "textures/items/settings_icon";
const ICON_HELP = "textures/items/help_icon";
const ICON_CREDITS = "textures/items/credits_icon";

/**
 * @param {import("@minecraft/server").Player} player
 */
export async function openMainMenu(player) {
    // Visual hierarchy pass: grouped into three sections via header()/
    // divider() (both confirmed real ActionFormData builder methods) -
    // Create (the two things a player opens most: starting/browsing
    // Replay, and Presets), Configure (Camera tools + Settings), and
    // Info (Help/Credits) at the bottom since they're the least-used
    // rows. This is purely a visual grouping - it doesn't reorder what
    // any button DOES, only how the list reads at a glance.
    //
    // Every row follows one consistent format: an icon, a bold title,
    // and a single short grey subtitle line underneath (via \n§r§8...) so
    // every button in this menu now has the same visual "shape" instead
    // of some being a bare word and others a full sentence.
    //
    // Selection routing note: rather than assuming header()/divider()/
    // label() leave button indices untouched (undocumented either way),
    // routing below is built from an actions array populated in the
    // exact order .button() is actually called - so it's correct
    // regardless of how the engine indexes non-button rows, with no
    // guessing required.
    const actions = [];

    const form = new ActionFormData().title("§6§lReplay Director").body("§7Choose a section below.\n§r§8Made by Ash Blast");

    form.header("§l§bCreate");
    form.button("§l§3Replay\n§r§8Record & play back", ICON_REPLAY);
    actions.push(() => openReplayMenu(player));
    form.button("§l§3Presets\n§r§8Ready-made shots", ICON_PRESETS);
    actions.push(() => openPresetsMenu(player));

    form.divider();
    form.header("§l§5Configure");
    form.button("§l§3Camera\n§r§8Shake presets", ICON_CAMERA);
    actions.push(() => openCameraMenu(player));
    form.button("§l§3Manual Camera Mode\n§r§8Custom keyframe paths", ICON_MANUAL_CAMERA);
    actions.push(() =>
        // standalone:true so its own Back button returns here (Main
        // Menu) directly, matching how it's reached - it's a top-level
        // category now, not a step down from Camera or Director
        // Controls. Works with or without a replay playing; see
        // manualCameraMenu.js's own doc comment for what that means.
        openManualCameraMenu(player, { standalone: true })
    );
    form.button("§l§3Settings\n§r§8Toggles & controls", ICON_SETTINGS);
    actions.push(() => openSettingsMenu(player));

    form.divider();
    form.header("§l§9Info");
    form.button("§l§3Help\n§r§8How to get started", ICON_HELP);
    actions.push(() =>
        openStubMenu(
            player,
            "Help",
            "§fReplay Director — Quick Help\n\n" +
            "§61. Start a replay\n" +
            "§7Use Replay to record, browse, rename, duplicate, delete, or play a replay.\n\n" +
            "§62. Use Presets\n" +
            "§7Choose a cinematic shot, select the focus, then set its shot options.\n\n" +
            "§63. Build a Manual Camera path\n" +
            "§7Open Manual Camera → add keyframes → choose Circular or Smooth Curves → play or preview the path.\n\n" +
            "§64. Direct a playing replay\n" +
            "§7Use the Director sticks for pause, speed, presets, keyframes, timeline, gamemode, actor skin, and stop.\n\n" +
            "§65. Fine-tune\n" +
            "§7Settings control countdown, camera collision, weather/time, and preset FOV.\n\n" +
            "§8Tip: The main Replay Director stick opens this menu. If you need a replacement, use /scriptevent replay:give."
        )
    );
    form.button("§l§3Credits & Discord\n§r§8About & bug reports", ICON_CREDITS);
    actions.push(() =>
        openStubMenu(
            player,
            "Credits & Discord",
            "§6Replay Director\n§r§8Made by §9Ash Blast\n\nFound a bug or have a suggestion? Report it on our Discord server:\n§bdiscord.gg/bkn94y9rpc\n\nThanks for using Replay Director!"
        )
    );

    form.title(premiumTitle("Replay Director"));
    const response = await form.show(player);
    if (response.canceled) return;

    const action = actions[response.selection];
    if (action) return action();
}
