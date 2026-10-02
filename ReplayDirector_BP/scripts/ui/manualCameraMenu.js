import { premiumSection, premiumActive, premiumDisabled, premiumPrimary, premiumSecondary, premiumDanger, premiumBack, premiumLabel, premiumBody } from "./theme.js";
/**
 * Replay Director - Manual Camera Mode (Phase 3H, opened up to work
 * outside replay playback too)
 *
 * ReplayCraft-style keyframe editor, built alongside Presets rather than
 * replacing them - the director picks whichever workflow fits the shot.
 * Playback reuses playSequence() from the existing camera engine
 * completely unchanged; this file only builds the keyframe list and
 * hands it off.
 *
 * Reachable two ways now: from Director Controls while a replay plays
 * (replayId-scoped keyframes, all features including Preview Path), or
 * directly from the Camera menu with nothing playing (replayId is
 * undefined, which pathState.js's playerId::replayId keying already
 * treats as its own separate bucket - a standalone path never mixes
 * with any specific replay's keyframes, and vice versa). Only Preview
 * Path (which plays the replay and camera path together in lock-step)
 * requires an actual live timeline to preview against, so that one
 * option is disabled without a replay playing; everything else works
 * either way.
 */

import { ActionFormData } from "@minecraft/server-ui";
import { playSequence, playTimelineSequence } from "../camera/cameraRunner.js";
import { isCountdownEnabled } from "../core/settings.js";
import { getPath, addKeyframe, snapshotActorArmor, clearPath, replacePath, autoCircularThreeKeyframes, getCurveMode } from "../manualCamera/pathState.js";
import { pushUndoSnapshot, undo, redo, canUndo, canRedo } from "../manualCamera/keyframeHistory.js";
import { buildSegments, totalDuration, buildTimelineSegments, firstTimelineTick, sortKeyframesByTimeline } from "../manualCamera/pathPlayer.js";
import { openDirectorControlsMenu } from "./directorControlsMenu.js";
import { openMainMenu } from "./mainMenu.js";
import { openKeyframeMenu } from "./keyframeMenu.js";
import { isPlaying, getPlayingReplayId, getProgress, getPlayheadTick, seekTo, resumePlayback, isPaused, getActiveActors } from "../replay/playback.js";
import { setActorEquipment } from "../replay/equipment.js";
import { startPathVisualization, stopPathVisualization } from "../manualCamera/pathVisualizer.js";
import { enterManualStickMode, exitManualStickMode, isInManualStickMode, getManualStickStatus } from "../manualCamera/manualCameraSticks.js";

/**
 * @param {import("@minecraft/server").Player} player
 * @param {{standalone?: boolean}} [opts] - standalone=true when reached directly from the Main Menu (its own top-level category) rather than Director Controls during playback. Only affects where the labeled "« Back" button goes (this screen has two genuinely different real entry points) - X/Escape always just closes the menu regardless.
 */
export async function openManualCameraMenu(player, opts = {}) {
    const { standalone = false } = opts;
    const playing = isPlaying();
    const replayId = playing ? getPlayingReplayId() : undefined;
    const backTarget = () => (standalone ? openMainMenu(player) : openDirectorControlsMenu(player));

    // Manual Camera is an in-world editing mode in BOTH contexts:
    // standalone and live Replay Playback. During a replay, the existing
    // playback sticks are temporarily swapped for the Manual Camera sticks
    // and restored on exit; the replay itself continues running untouched.
    const wasAlreadyInStickMode = isInManualStickMode(player.id);
    enterManualStickMode(player, { replayActive: playing });

    if (isInManualStickMode(player.id)) {
        startPathVisualization(player, replayId, () => undefined);
        if (!wasAlreadyInStickMode) {
            player.sendMessage(
                `§aREPLAY DIRECTOR §8| §aManual Camera active. §2Hotbar: §aAdd Keyframe §2• §aManage §2• §aPlay Path §2• §aClear §2• §aExit §2• §aUndo §2• §2Redo §2• §aCurve Here §2• §aCurve Mode.`
            );
            player.sendMessage(
                playing
                    ? "§aReplay is still running. Your Manual Camera keyframes and path are scoped to this replay."
                    : "§aUse your normal movement/look controls to frame the camera. Add at least 2 keyframes to display the camera path guide."
            );
        }
        return;
    }

    const path = getPath(player.id, replayId);
    const count = path.keyframes.length;
    const seconds = count > 1 ? (totalDuration(path.keyframes) / 20).toFixed(1) : "0.0";
    const undoAvailable = canUndo(player.id, replayId);
    const redoAvailable = canRedo(player.id, replayId);
    const stickStatus = getManualStickStatus(player);

    // Camera Path Visualization (QoL pass): live while this menu (or the
    // Keyframe menu it opens into) is on screen. Restarted every time this
    // function runs - which happens on every menu redraw already, since
    // this function re-opens itself after each action - so it always
    // reflects whatever the path looks like right now with no separate
    // "did the path change" check needed. No selection highlight at this
    // level (that's keyframeMenu.js's detail screen); undefined is fine.
    startPathVisualization(player, replayId, () => undefined);

    const form = new ActionFormData()
        .title("§6§lManual Camera Mode")
        .body(
            `§fMANUAL CAMERA\n` +
            `§2● PATH EDITING §8| §fNative movement + look controls remain available while editing.\n` +
            `§7Keyframes §f${count}   §7Path length §f${seconds}s   §7Path guide §f${count >= 2 ? "VISIBLE" : "WAITING FOR 2 KEYFRAMES"}\n` +
            `§7Manual Camera controls §f${stickStatus.loaded}/${stickStatus.total} §7loaded in hotbar\n` +
            `§8[1] Add  [2] Manage  [3] Play  [4] Clear\n` +
            `§8[5] Exit  [6] Undo  [7] Redo  [8] Curve Here` +
            `\n§7Curve mode §f${getCurveMode(player.id, replayId) === "circular" ? "Circular Curves" : "Smooth Curves"}` +
            `${playing ? "\n§r§8Replay §2● LIVE — Preview Path can lock to the timeline. Playback sticks remain active." : "\n§r§8Replay §7Offline — Preview Path is unavailable."}` +
            `${playing ? "\n§2✔ Manual Camera editing controls are available in this menu." : (isInManualStickMode(player.id) && stickStatus.loaded === stickStatus.total ? "\n§2✔ All Manual Camera controls are ready." : "\n§c⚠ Manual Camera controls are incomplete.")}`
        )
        .button("§2+ Add Keyframe Here")
        .button(count > 0 ? "§3Edit / Reorder Keyframes" : "§8Edit / Reorder Keyframes (none yet)")
        .button(count >= 2 && playing ? "§3Preview Path" : "§8Preview Path (needs a replay playing + 2 keyframes)")
        .button(count >= 2 ? "§2Play Camera Animation" : "§8Play Camera Animation (need 2+ keyframes)")
        .button(count > 0 ? "§4Clear Path" : "§8Clear Path (nothing to clear)")
        .button(undoAvailable ? "§3↺ Undo" : "§8↺ Undo (nothing to undo)")
        .button(redoAvailable ? "§3↻ Redo" : "§8↻ Redo (nothing to redo)")
        .button("§3Exit Manual Camera");

    premiumSection(form, "MANUAL CAMERA", "Manual Camera");
    const response = await form.show(player);
    if (response.canceled) {
        // Closing the editor with the native X/Escape action is also an
        // exit from the editor session. Do the same visualization and
        // inventory cleanup as the explicit Back/Exit action.
        stopPathVisualization(player);
        exitManualStickMode(player);
        return;
    }

    switch (response.selection) {
        case 0: {
            const { currentTick } = playing ? getProgress() : { currentTick: 0 };
            const armorSnapshot = snapshotActorArmor(replayId);
            pushUndoSnapshot(player.id, replayId, getPath(player.id, replayId).keyframes);
            const index = addKeyframe(player.id, replayId, player.getHeadLocation(), player.getRotation(), currentTick, armorSnapshot);
            const pathAfterAdd = getPath(player.id, replayId);
            const circleResult = pathAfterAdd.keyframes.length >= 3
                ? autoCircularThreeKeyframes(player.id, replayId)
                : { applied: false };
            if (circleResult.applied) {
                player.sendMessage(`§a✔ ${getCurveMode(player.id, replayId) === "circular" ? "Circular curve path" : "Smooth curve path"} updated — it will continue through all keyframes.`);
            }
            player.sendMessage(
                playing
                    ? `§a✔ Keyframe §9${index + 1}§a added at §9${(currentTick / 20).toFixed(1)}s§a into the replay.`
                    : `§a✔ Keyframe §9${index + 1}§a added.`
            );
            return openManualCameraMenu(player, opts);
        }
        case 1:
            if (count === 0) return openManualCameraMenu(player, opts);
            return openKeyframeMenu(player, opts);
        case 2:
            if (count < 2 || !playing) return openManualCameraMenu(player, opts);
            stopPathVisualization(player);
            return runPath(player, { preview: true });
        case 3:
            if (count < 2) return openManualCameraMenu(player, opts);
            stopPathVisualization(player);
            return runPath(player, { preview: false }, opts);
        case 4:
            if (count === 0) return openManualCameraMenu(player, opts);
            return confirmClear(player, replayId, opts);
        case 5: {
            if (!undoAvailable) return openManualCameraMenu(player, opts);
            const restored = undo(player.id, replayId, getPath(player.id, replayId).keyframes);
            if (restored) {
                replacePath(player.id, replayId, restored);
                player.sendMessage("§7Undid last keyframe edit.");
            }
            return openManualCameraMenu(player, opts);
        }
        case 6: {
            if (!redoAvailable) return openManualCameraMenu(player, opts);
            const restored = redo(player.id, replayId, getPath(player.id, replayId).keyframes);
            if (restored) {
                replacePath(player.id, replayId, restored);
                player.sendMessage("§7Redid keyframe edit.");
            }
            return openManualCameraMenu(player, opts);
        }
        case 7:
            stopPathVisualization(player);
            exitManualStickMode(player);
            return backTarget();
    }
}

export async function confirmClear(player, replayId, opts) {
    // When called from a Manual Camera stick, replayId may be omitted.
    // Resolve the active replay here so the same clear action works in both
    // standalone Manual Camera and live Replay Manual Camera mode.
    const scopedReplayId = replayId !== undefined
        ? replayId
        : (isPlaying() ? getPlayingReplayId() : undefined);

    const form = new ActionFormData()
        .title("Clear Path")
        .body("§cThis removes every keyframe in your current path. You can Undo it from the Manual Camera menu right after.")
        .button("§3Clear")
        .button("§4Cancel");

    premiumSection(form, "MANUAL CAMERA", "Manual Camera");
    const response = await form.show(player);
    if (!response.canceled && response.selection === 0) {
        pushUndoSnapshot(player.id, scopedReplayId, getPath(player.id, scopedReplayId).keyframes);
        clearPath(player.id, scopedReplayId);
        player.sendMessage("§7Path cleared.");
    }
    return openManualCameraMenu(player, opts);
}

/**
 * @param {import("@minecraft/server").Player} player
 * @param {{preview:boolean}} options
 * @param {{standalone?: boolean}} [opts]
 */
export async function runPath(player, { preview }, opts = {}) {
    // Path visualization is an editor aid only. Stop it before any playback
    // entry point (menu or Manual Camera stick) so editor particles cannot
    // continue refreshing while the camera is running.
    stopPathVisualization(player);

    const replayId = isPlaying() ? getPlayingReplayId() : undefined;
    const path = getPath(player.id, replayId);

    if (!preview) {
        // "Play Camera Animation" - a standalone, camera-only run paced by
        // each keyframe's own holdTicks, with no replay timeline attached.
        // Works identically with or without a replay playing, since it was
        // never coupled to one in the first place.
        const segments = buildSegments(path.keyframes, { sway: true, getActiveActors, curveEnabled: path.curveEnabled !== false });
        player.sendMessage("§d● PATH PLAYBACK §8| §fCamera animation started. Editor visualization is disabled.");
        await playSequence(player, {
            segments,
            countdown: isCountdownEnabled(),
            freezeSubject: false,
            subject: undefined,
            disableCollision: true, // manual keyframes are deliberately authored positions - don't second-guess them
            onComplete: () => {
                if (player.isValid) {
                    player.sendMessage("§a✔ Camera animation finished.");
                    // Return to editor mode without reintroducing the old
                    // playback-time red overlay. The visualizer is the
                    // neutral editor guide only.
                    if (isInManualStickMode(player.id)) {
                        startPathVisualization(player, undefined, () => undefined);
                    }
                }
            }
        });
        return;
    }

    return runTimelinePreview(player, path);
}

/**
 * Preview Path (Phase 3J): plays the replay and the keyframe camera path
 * together, in lock-step, so what's shown here is exactly what the final
 * cinematic will look like - not a camera-only approximation.
 *
 * Requires a replay to already be playing - the only one of Manual Camera
 * Mode's actions still gated that way (see the case 2 check in
 * openManualCameraMenu above), since previewing "the replay + camera path
 * together" has nothing to play without a live replay. Rather than
 * starting a second, independent playback, this rewinds the SAME playing
 * replay to the first keyframe's recorded moment and lets it run forward
 * from there, with the camera reading that replay's live tick every frame
 * (playTimelineSequence in cameraRunner.js) instead of counting its own
 * elapsed ticks. Whatever speed the replay is currently set to (0.25x-4x,
 * via the existing Timeline/Director Stick speed controls) applies
 * automatically, since the camera is just following the replay's actual
 * playhead rather than running its own clock.
 *
 * @param {import("@minecraft/server").Player} player
 * @param {{keyframes: Array<object>}} path
 */
async function runTimelinePreview(player, path) {
    const replayId = getPlayingReplayId();
    const timelineKeyframes = sortKeyframesByTimeline(path.keyframes);
    const segments = buildTimelineSegments(timelineKeyframes, { sway: false, getActiveActors, curveEnabled: path.curveEnabled !== false });

    // Armor-at-keyframe: only keyframes that actually have a snapshot
    // contribute a point (older keyframes captured before this feature
    // existed have armorSnapshot === undefined and are skipped rather than
    // wiping an actor's armor with an empty snapshot). Kept in ascending
    // timelineTick order, same order keyframes are already stored in.
    const keyframeArmorPoints = timelineKeyframes
        .filter((k) => k.armorSnapshot && Object.keys(k.armorSnapshot).length > 0)
        .map((k) => ({ timelineTick: k.timelineTick, armorSnapshot: k.armorSnapshot }));

    // Applies one keyframe's {[actorPlayerId]: armor} snapshot to whichever
    // of those actors are actually live right now - same live-entity
    // lookup and setActorEquipment() call replayActorMenu.js's
    // liveApplyIfPlaying uses, just driven by the timeline instead of a
    // menu save. An actor not currently spawned (or removed from the
    // replay since) is silently skipped rather than erroring.
    function applyArmorSnapshot(snapshot) {
        const activeActors = getActiveActors();
        if (!activeActors) return;
        for (const [actorPlayerId, armor] of Object.entries(snapshot)) {
            const match = activeActors.find((a) => a.playerId === actorPlayerId);
            if (!match || !match.entity || !match.entity.isValid) continue;
            for (const slotKey of ["head", "chest", "legs", "feet", "mainhand", "offhand"]) {
                const piece = armor[slotKey];
                setActorEquipment(match.entity, slotKey, piece ? piece.typeId : undefined, piece ? piece.amount : 1);
            }
        }
    }

    // Rewind the live replay to the moment the path begins, so the preview
    // always plays the full path from its start rather than from wherever
    // the timeline happened to be sitting when Preview Path was clicked.
    seekTo(firstTimelineTick(path.keyframes));
    if (isPaused()) resumePlayback();

    player.sendMessage("§d● PATH PLAYBACK §8| §fPreview locked to the replay timeline. Editor visualization is disabled.");

    await playTimelineSequence(player, {
        segments,
        getTimelineTick: () => getPlayheadTick(),
        isTimelineActive: () => isPlaying() && getPlayingReplayId() === replayId,
        disableCollision: true, // manual keyframes are deliberately authored positions - don't second-guess them
        keyframeArmorPoints,
        applyArmorSnapshot,
        onComplete: () => {
            if (player.isValid) {
                player.sendMessage(
                    isPlaying() ? "§a✔ Preview finished." : "§7Preview stopped - replay ended or was stopped."
                );
            }
        }
    });
}
