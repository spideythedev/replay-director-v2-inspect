import { ActionFormData } from "@minecraft/server-ui";
import { getPath, getCurveMode, setCurveMode } from "../manualCamera/pathState.js";
import { premiumSection } from "./theme.js";
import { isPlaying, getPlayingReplayId } from "../replay/playback.js";

/**
 * Replay Director - Manual Camera Curve Mode Menu
 *
 * Opened by the Manual Camera Curve stick.
 *
 * Two automatic curve algorithms are deliberately exposed:
 *  - Circular Curves: exact local 3-point circle arcs. With 3 keyframes,
 *    both transitions share the exact same circle through all three points.
 *    With 4+ keyframes, each transition continues using the nearest
 *    consecutive three-keyframe circle instead of becoming straight.
 *  - Smooth Curves: the current continuous Catmull-Rom implementation.
 *
 * This menu changes only automatically-managed curve transitions. Explicit
 * "Curve Here", orbit, focus, and other manually-authored path choices are
 * preserved.
 */
export async function openManualCameraCurveModeMenu(player) {
    const replayId = isPlaying() ? getPlayingReplayId() : undefined;
    const currentMode = getCurveMode(player.id, replayId);

    const form = new ActionFormData()
        .title("§6§lCurve Mode")
        .body(
            "§7Choose a camera path style.\n\n" +
            `§7Current: ${currentMode === "circular" ? "§6Circular Curves" : "§bSmooth Curves"}`
        )
        .button("§6Circular Curves\n§r§8Accurate circular arcs")
        .button("§bSmooth Curves\n§r§8Continuous smooth path");

    premiumSection(form, "MANUAL CAMERA", "Curve Mode");
    const response = await form.show(player);

    if (response.canceled || response.selection === undefined) return;

    const mode = response.selection === 0 ? "circular" : "smooth";
    const changed = setCurveMode(player.id, replayId, mode);

    if (!changed) {
        player.sendMessage("§cCurve mode could not be changed.");
        return;
    }

    if (mode === "circular") {
        player.sendMessage("§6◆ Circular Curves selected — automatic curves now use exact 3-point circle arcs.");
    } else {
        player.sendMessage("§b◆ Smooth Curves selected — automatic curves now use the continuous smooth path.");
    }
}
