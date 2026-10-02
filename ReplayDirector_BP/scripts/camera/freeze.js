/**
 * Replay Director - Target Freeze
 *
 * Freezes the cinematic subject in place (movement + camera + attacking)
 * so presets can rely on a stationary target, then restores their normal
 * input permissions when the cinematic ends.
 *
 * Mobile Touch Compatibility pass: on touch-screen devices, disabling
 * InputPermissionCategory.Movement/Camera/LateralMovement is exactly what
 * makes the on-screen joystick and jump button stop responding (the
 * input-permission system gates touch controls the same way it gates
 * keyboard/controller input on other platforms) - there's no separate,
 * touch-specific input category to leave enabled instead. settings.js's
 * isKeepTouchControlsEnabled() (OFF by default, matching the exact prior
 * behavior for anyone who doesn't touch it) lets a player opt into
 * keeping their touch controls fully usable during a cinematic, at the
 * cost of no longer being frozen in place - freezeTarget() simply skips
 * the disable step entirely when it's on, rather than disabling and
 * immediately re-enabling (which would still cause the same visible
 * flicker/momentary unresponsiveness this setting exists to avoid).
 */

import { InputPermissionCategory } from "@minecraft/server";
import { isKeepTouchControlsEnabled } from "../core/settings.js";

/** @type {Set<string>} player ids currently frozen by Replay Director */
const frozen = new Set();

/**
 * @param {import("@minecraft/server").Player} player
 */
export function freezeTarget(player) {
    if (!player.isValid) return;
    // Still tracked as "frozen" even when the setting skips the actual
    // input-disable below - unfreezeTarget()/unfreezeTargetById() setting
    // an already-enabled category back to true is a harmless no-op, and
    // keeping the tracking consistent means every other piece of freeze.js
    // (isFrozen(), the rejoin safety net) keeps working exactly the same
    // regardless of which path was taken here.
    frozen.add(player.id);
    if (isKeepTouchControlsEnabled()) return;
    try {
        player.inputPermissions.setPermissionCategory(InputPermissionCategory.Movement, false);
        player.inputPermissions.setPermissionCategory(InputPermissionCategory.Camera, false);
        player.inputPermissions.setPermissionCategory(InputPermissionCategory.LateralMovement, false);
    } catch (e) {
        // Input permission categories can vary slightly by API version; fail soft.
    }
}

/**
 * @param {import("@minecraft/server").Player} player
 */
export function unfreezeTarget(player) {
    if (!player || !frozen.has(player.id)) return;
    frozen.delete(player.id);
    if (!player.isValid) return;
    try {
        player.inputPermissions.setPermissionCategory(InputPermissionCategory.Movement, true);
        player.inputPermissions.setPermissionCategory(InputPermissionCategory.Camera, true);
        player.inputPermissions.setPermissionCategory(InputPermissionCategory.LateralMovement, true);
    } catch (e) {
        // fail soft
    }
}

/**
 * Unfreezes by id alone, without needing a live Player object - used when
 * the original player reference may have gone invalid (disconnect mid-
 * cinematic) but the SAME player is now back and valid again (e.g. a
 * fresh Player object from a rejoin event). Without this, a player who
 * disconnected while frozen had no way to ever have their input
 * permissions restored - unfreezeTarget's own isValid guard would return
 * early forever on the stale reference, and nothing else in the codebase
 * ever called setPermissionCategory(..., true) again for that id. This is
 * the confirmed root cause of "movement sometimes doesn't work correctly"
 * reports: once stuck, Movement/Camera/LateralMovement stayed permanently
 * disabled for that player until the world was reloaded (which resets all
 * script-held permission state), regardless of which touch control layout
 * (classic buttons vs joystick) they were using - the classic/button
 * layout was more likely to be reported specifically because its jump/
 * sneak/attack buttons are separate, individually-obvious controls, so a
 * stuck Movement-disabled state is more noticeable there than on a
 * joystick where "the stick doesn't move me" reads the same either way.
 * @param {import("@minecraft/server").Player} player - a currently-valid Player object for this id
 */
export function unfreezeTargetById(player) {
    if (!player || !player.isValid) return;
    if (!frozen.has(player.id)) return;
    frozen.delete(player.id);
    try {
        player.inputPermissions.setPermissionCategory(InputPermissionCategory.Movement, true);
        player.inputPermissions.setPermissionCategory(InputPermissionCategory.Camera, true);
        player.inputPermissions.setPermissionCategory(InputPermissionCategory.LateralMovement, true);
    } catch (e) {
        // fail soft
    }
}

export function isFrozen(playerId) {
    return frozen.has(playerId);
}

/** Safety net: unfreeze everyone (e.g. on script reload / world init). */
export function unfreezeAllTracked(getPlayerById) {
    for (const id of [...frozen]) {
        const player = getPlayerById(id);
        if (player) unfreezeTarget(player);
        else frozen.delete(id);
    }
}
