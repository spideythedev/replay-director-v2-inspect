import { premiumSection, premiumActive, premiumDisabled, premiumPrimary, premiumSecondary, premiumDanger, premiumBack, premiumLabel, premiumBody } from "./theme.js";
/**
 * Replay Director - Settings Menu
 *
 * Phase 2: countdown toggle, camera-collision toggle, and cinematic
 * weather/time overrides. HUD-element-by-element toggles and
 * hide-replay-entity land with the Replay system in a later phase.
 */

import { ActionFormData, ModalFormData } from "@minecraft/server-ui";
import {
    isCountdownEnabled,
    setCountdownEnabled,
    isCollisionEnabled,
    setCollisionEnabled,
    isKeepTouchControlsEnabled,
    setKeepTouchControlsEnabled,
    getPresetFov,
    setPresetFov,
    MIN_PRESET_FOV,
    MAX_PRESET_FOV
} from "../core/settings.js";
import { openMainMenu } from "./mainMenu.js";

/**
 * @param {import("@minecraft/server").Player} player
 */
export async function openSettingsMenu(player) {
    const countdownOn = isCountdownEnabled();
    const collisionOn = isCollisionEnabled();
    const keepTouchOn = isKeepTouchControlsEnabled();
    const presetFov = getPresetFov();

    const form = new ActionFormData()
        .title("§6§lSettings")
        .body("§7Toggle a setting or open a sub-menu.")
        .button(`Countdown: ${countdownOn ? "§aON" : "§cOFF"}`)
        .button(`Camera Collision: ${collisionOn ? "§aON" : "§cOFF"}`)
        .button(
            `Keep Touch Controls: ${keepTouchOn ? "§aON" : "§cOFF"}\n§r§8${
                keepTouchOn ? "Joystick/buttons stay usable during cinematics." : "Touch controls are frozen during cinematics (default)."
            }`
        )
        .button(`Preset FOV: §9${presetFov}\n§r§8Applies to every cinematic preset, preview, and playback.`)
        .button("§3Weather Control")
        .button("§3Time Control")
        .button("§3« Back");

    premiumSection(form, "SETTINGS", "Settings");
    const response = await form.show(player);
    if (response.canceled) return;

    switch (response.selection) {
        case 0:
            setCountdownEnabled(!countdownOn);
            return openSettingsMenu(player);
        case 1:
            setCollisionEnabled(!collisionOn);
            return openSettingsMenu(player);
        case 2:
            setKeepTouchControlsEnabled(!keepTouchOn);
            return openSettingsMenu(player);
        case 3:
            return openPresetFovMenu(player, presetFov);
        case 4:
            return openWeatherMenu(player);
        case 5:
            return openTimeMenu(player);
        case 6:
            return openMainMenu(player);
    }
}

/**
 * Global Preset FOV picker - a slider matching the existing precedent in
 * keyframeMenu.js/timelineMenu.js. Saving here is the ONLY way this value
 * changes; cameraRunner.js just reads it back via getPresetFov() at shot
 * time, so there's nothing else to keep in sync.
 * @param {import("@minecraft/server").Player} player
 * @param {number} currentFov
 */
async function openPresetFovMenu(player, currentFov) {
    const form = new ModalFormData()
        .title("Preset FOV")
        .slider(`Field of View (${MIN_PRESET_FOV}-${MAX_PRESET_FOV})`, MIN_PRESET_FOV, MAX_PRESET_FOV, {
            valueStep: 1,
            defaultValue: currentFov
        });

    premiumSection(form, "SETTINGS", "Preset FOV");
    const response = await form.show(player);
    if (response.canceled) return openSettingsMenu(player);

    const [fov] = response.formValues;
    setPresetFov(fov);
    player.sendMessage(`§a✔ Preset FOV set to §9${fov}§a.`);
    return openSettingsMenu(player);
}

const WEATHER_OPTIONS = [
    { label: "Clear", command: "weather clear" },
    { label: "Rain", command: "weather rain" },
    { label: "Thunder", command: "weather thunder" }
];

async function openWeatherMenu(player) {
    const form = new ActionFormData().title("§6Weather Control");
    for (const opt of WEATHER_OPTIONS) form.button(opt.label);
    form.button("§3« Back");

    premiumSection(form, "SETTINGS", "Weather Control");
    const response = await form.show(player);
    if (response.canceled) return;
    if (response.selection === WEATHER_OPTIONS.length) return openSettingsMenu(player);

    runSafely(player, WEATHER_OPTIONS[response.selection].command);
    player.sendMessage(`§a✔ Weather set to ${WEATHER_OPTIONS[response.selection].label}.`);
    return openSettingsMenu(player);
}

const TIME_OPTIONS = [
    { label: "Sunrise", command: "time set sunrise" },
    { label: "Morning", command: "time set day" },
    { label: "Noon", command: "time set noon" },
    { label: "Evening", command: "time set 13000" },
    { label: "Sunset", command: "time set sunset" },
    { label: "Night", command: "time set night" },
    { label: "Midnight", command: "time set midnight" }
];

async function openTimeMenu(player) {
    const form = new ActionFormData().title("§6Time Control");
    for (const opt of TIME_OPTIONS) form.button(opt.label);
    form.button("§3« Back");

    premiumSection(form, "SETTINGS", "Time Control");
    const response = await form.show(player);
    if (response.canceled) return;
    if (response.selection === TIME_OPTIONS.length) return openSettingsMenu(player);

    runSafely(player, TIME_OPTIONS[response.selection].command);
    player.sendMessage(`§a✔ Time set to ${TIME_OPTIONS[response.selection].label}.`);
    return openSettingsMenu(player);
}

function runSafely(player, command) {
    try {
        player.runCommand(command);
    } catch (e) {
        player.sendMessage("§cCouldn't run that command - try again.");
    }
}
