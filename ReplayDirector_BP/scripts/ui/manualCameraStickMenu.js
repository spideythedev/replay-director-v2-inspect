import { stopPathVisualization } from "../manualCamera/pathVisualizer.js";
import { premiumSection, premiumActive, premiumDisabled, premiumPrimary, premiumSecondary, premiumDanger, premiumBack, premiumLabel, premiumBody } from "./theme.js";
/**
 * Replay Director - Manual Camera Mode Stick Handlers
 *
 * One handler per Manual Camera Mode stick (see manualCameraSticks.js for
 * the stick identities/inventory management). Every handler here calls
 * straight into the SAME existing functions the Manual Camera Mode menu
 * already uses (pathState.js, keyframeHistory.js, manualCameraMenu.js's
 * own exported confirmClear/runPath, keyframeMenu.js) - nothing here
 * reimplements or duplicates that logic, per the explicit requirement.
 *
 * This file is completely separate from ui/stickMenu.js (the 7 Replay
 * Playback sticks) - no shared state, no shared handler map, no import
 * from each other. A player can never have both stick sets active at
 * once anyway (manualCameraMenu.js's own !playing gate on
 * enterManualStickMode ensures that), but keeping the files themselves
 * independent means a change to one categorically cannot affect the
 * other.
 */

import {
    getPath,
    snapshotActorArmor,
    addKeyframe,
    replacePath,
    setKeyframeCurveHere,
    autoCircularThreeKeyframes
} from "../manualCamera/pathState.js";
import { pushUndoSnapshot, undo, redo, canUndo, canRedo } from "../manualCamera/keyframeHistory.js";
import { exitManualStickMode } from "../manualCamera/manualCameraSticks.js";
import { openKeyframeMenu } from "./keyframeMenu.js";
import { confirmClear, runPath } from "./manualCameraMenu.js";
import { isPlaying, getPlayingReplayId, getProgress } from "../replay/playback.js";
import { openManualCameraCurveModeMenu } from "./manualCameraCurveModeMenu.js";

/**
 * Add Keyframe Stick - places a keyframe at the player's current camera
 * position instantly, same as the menu's "+ Add Keyframe Here" button
 * (manualCameraMenu.js case 0) - this IS that same logic, not a
 * reimplementation, since Manual Camera Mode's stick mode only ever
 * activates when nothing is playing (see manualCameraSticks.js's gate),
 * so replayId is always undefined here exactly as it would be from the
 * menu in that same state.
 */
export function useManualStickAddKeyframe(player) {
    const playing = isPlaying();
    const replayId = playing ? getPlayingReplayId() : undefined;
    const { currentTick } = playing ? getProgress() : { currentTick: 0 };
    const armorSnapshot = snapshotActorArmor(replayId);
    pushUndoSnapshot(player.id, replayId, getPath(player.id, replayId).keyframes);
    const index = addKeyframe(player.id, replayId, player.getHeadLocation(), player.getRotation(), currentTick, armorSnapshot);
    const pathAfterAdd = getPath(player.id, replayId);
    const circleResult = pathAfterAdd.keyframes.length >= 3
        ? autoCircularThreeKeyframes(player.id, replayId)
        : { applied: false };
    player.sendMessage(`§a✔ Keyframe §9${index + 1}§a added.`);
    if (circleResult.applied) {
        player.sendMessage("§a✔ Smooth curve path updated — it will continue through all keyframes.");
    }
}

/** Manage Keyframes Stick - opens the existing Keyframe Management submenu (keyframeMenu.js), unchanged. standalone:true so its own Back button returns to a closed state rather than assuming Director Controls, matching how stick-mode is only ever active without a replay playing. */
export async function useManualStickManageKeyframes(player) {
    const replayId = isPlaying() ? getPlayingReplayId() : undefined;
    const path = getPath(player.id, replayId);
    if (path.keyframes.length === 0) {
        player.sendMessage("§7No keyframes yet - use Add Keyframe first.");
        return;
    }
    return openKeyframeMenu(player, { standalone: true });
}

/**
 * Play Camera Animation Stick - runs the exact same runPath(player,
 * {preview:false}) the menu's "Play Camera Animation" button calls
 * (manualCameraMenu.js case 3), reused directly via that function's
 * export rather than reimplemented here.
 */
export async function useManualStickPlayAnimation(player) {
    const replayId = isPlaying() ? getPlayingReplayId() : undefined;
    const path = getPath(player.id, replayId);
    if (path.keyframes.length < 2) {
        player.sendMessage("§7Need at least 2 keyframes to play a camera animation.");
        return;
    }
    return runPath(player, { preview: false }, { standalone: true });
}

/** Clear Path Stick - opens the SAME confirmation dialog the menu's "Clear Path" button uses (manualCameraMenu.js's exported confirmClear), not a separate/simplified confirmation. */
export async function useManualStickClearPath(player) {
    const replayId = isPlaying() ? getPlayingReplayId() : undefined;
    const path = getPath(player.id, replayId);
    if (path.keyframes.length === 0) {
        player.sendMessage("§7Nothing to clear.");
        return;
    }
    return confirmClear(player, undefined, { standalone: true });
}

/** Exit Manual Camera Mode Stick - immediately restores the player's original inventory exactly as saved, and removes the sticks. This is the "explicit Exit" referred to elsewhere in this addon's design notes - Play Camera Animation deliberately does NOT restore inventory on its own, only this does. */
export function useManualStickExit(player) {
    stopPathVisualization(player);
    exitManualStickMode(player);
    player.sendMessage(isPlaying() ? "§7Exited Manual Camera Mode - Replay Director controls restored." : "§7Exited Manual Camera Mode - your items are back.");
}

/** Undo Stick - same undo(...)+replacePath(...) pair the menu's Undo button uses (manualCameraMenu.js case 5), applied instantly with no submenu, per the requirement that Undo/Redo sticks work without opening one. */
export function useManualStickUndo(player) {
    const replayId = isPlaying() ? getPlayingReplayId() : undefined;
    if (!canUndo(player.id, replayId)) {
        player.sendMessage("§7Nothing to undo.");
        return;
    }
    const restored = undo(player.id, replayId, getPath(player.id, replayId).keyframes);
    if (restored) {
        replacePath(player.id, replayId, restored);
        player.sendMessage("§7Undid last keyframe edit.");
    }
}

/** Redo Stick - same redo(...)+replacePath(...) pair the menu's Redo button uses (manualCameraMenu.js case 6), applied instantly with no submenu. */
export function useManualStickRedo(player) {
    const replayId = isPlaying() ? getPlayingReplayId() : undefined;
    if (!canRedo(player.id, replayId)) {
        player.sendMessage("§7Nothing to redo.");
        return;
    }
    const restored = redo(player.id, replayId, getPath(player.id, replayId).keyframes);
    if (restored) {
        replacePath(player.id, replayId, restored);
        player.sendMessage("§7Redid keyframe edit.");
    }
}


/**
 * Curve Here Stick - uses the current camera position as the single,
 * beginner-friendly control point for the LAST keyframe transition.
 * The user simply places two or more keyframes, moves to the place where
 * the path should bend, and taps this stick. Existing advanced path-point
 * data is replaced for this transition by the single Curve Here handle.
 */
export function useManualStickCurveHere(player) {
    const replayId = isPlaying() ? getPlayingReplayId() : undefined;
    const path = getPath(player.id, replayId);
    if (path.keyframes.length < 2) {
        player.sendMessage("§7Add at least 2 keyframes before using Curve Here.");
        return;
    }

    const targetIndex = path.keyframes.length - 1;
    pushUndoSnapshot(player.id, replayId, path.keyframes);
    const applied = setKeyframeCurveHere(
        player.id,
        replayId,
        targetIndex,
        player.getHeadLocation()
    );

    if (applied) {
        player.sendMessage(
            `§f◆ §aCurve added to Keyframe §c${targetIndex + 1}§a. Move and use Curve Here again to reposition the bend.`
        );
    }
}

/**
 * Curve Mode Stick - opens the two-mode curve selector instead of simply
 * toggling curves on/off. The selected mode is stored on the current path
 * and immediately rebuilds its automatically-managed curve transitions.
 */
export function useManualStickCurveToggle(player) {
    return openManualCameraCurveModeMenu(player);
}
