import { premiumSection, premiumActive, premiumDisabled, premiumPrimary, premiumSecondary, premiumDanger, premiumBack, premiumLabel, premiumBody } from "./theme.js";
/**
 * Replay Director - Keyframe Editor (Phase 3H)
 *
 * Timeline-aware Keyframes pass: every keyframe now remembers the replay
 * tick it was captured at (see pathState.js), and this menu is scoped to
 * whichever replay is currently playing (getPlayingReplayId()) instead of
 * a single global path per director. A new "Jump Here" action moves BOTH
 * the director's own position/rotation AND the replay's timeline playhead
 * to a keyframe's exact recorded moment in one step, so re-editing an old
 * keyframe means actually seeing what the replay looked like when it was
 * placed, not guessing from stale numbers.
 */

import { ActionFormData, ModalFormData } from "@minecraft/server-ui";
import { EASING } from "../core/constants.js";
import {
    getPath,
    removeKeyframe,
    updateKeyframeLocation,
    updateKeyframeTiming,
    moveKeyframe,
    snapshotActorArmor,
    setKeyframeCurveHere,
    clearKeyframeCurve
} from "../manualCamera/pathState.js";
import { pushUndoSnapshot } from "../manualCamera/keyframeHistory.js";
import { openManualCameraMenu } from "./manualCameraMenu.js";
import { getPlayingReplayId, seekTo, getProgress, isPlaying } from "../replay/playback.js";
import { startPathVisualization, stopPathVisualization } from "../manualCamera/pathVisualizer.js";
import { isInManualStickMode } from "../manualCamera/manualCameraSticks.js";

const EASING_OPTIONS = [EASING.LINEAR, EASING.EASE_IN, EASING.EASE_OUT, EASING.EASE_IN_OUT];
const EASING_LABELS = ["Linear", "Ease In", "Ease Out", "Ease In-Out"];

/** Path type key -> display label + one-line description, in the exact order shown in the picker. Adding a new path type later means adding one entry here AND one entry in pathTypes.js's PATH_TYPES registry - nothing else in this file changes. */
const PATH_TYPE_INFO = {
    straight: { label: "Straight", desc: "Direct line to the next keyframe" },
    curve: { label: "Smooth Curve", desc: "Smooth curved trajectory" },
    circular: { label: "Circular", desc: "Arcs around a target" },
    circular3d: { label: "3-Point Circle", desc: "Automatic circle through three keyframes" },
    orbit: { label: "Orbit", desc: "Circles a target, always facing it" },
    focus: { label: "Focus Point", desc: "Moves normally, always facing a target" }
};

/**
 * @param {import("@minecraft/server").Player} player
 * @param {{standalone?: boolean}} [opts] - passed straight through to openManualCameraMenu on Back; see that file's opts doc.
 */
export async function openKeyframeMenu(player, opts = {}) {
    const replayId = isPlaying() ? getPlayingReplayId() : undefined;
    const path = getPath(player.id, replayId);

    if (path.keyframes.length === 0) {
        player.sendMessage("§7No keyframes left to edit.");
        return openManualCameraMenu(player, opts);
    }

    // Still editing at this level, no single keyframe "selected" yet -
    // same as the list-level screen in manualCameraMenu.js.
    startPathVisualization(player, replayId, () => undefined);

    const form = new ActionFormData().title("§6Keyframes").body("§7Select a keyframe to edit, reorder, or delete.");
    path.keyframes.forEach((kf, i) => {
        form.button(`§3#${i + 1}\n§r§8x:${round1(kf.location.x)} y:${round1(kf.location.y)} z:${round1(kf.location.z)} §8@${(kf.timelineTick / 20).toFixed(1)}s`);
    });
    form.button("§3« Back");

    premiumSection(form, "KEYFRAME EDITOR", "Keyframe Editor");
    const response = await form.show(player);
    if (response.canceled) {
        resumeOrStopVisualization(player, opts);
        return;
    }

    // The final button is Back. Previously it was passed through as though
    // it were a keyframe index, which reopened this same list instead of
    // returning to Manual Camera.
    if (response.selection === path.keyframes.length) {
        if (opts.standalone) {
            return openManualCameraMenu(player, opts);
        }
        return openManualCameraMenu(player, opts);
    }

    return openKeyframeDetailMenu(player, response.selection, opts);
}

async function openKeyframeDetailMenu(player, index, opts = {}) {
    const playing = isPlaying();
    const replayId = playing ? getPlayingReplayId() : undefined;
    const path = getPath(player.id, replayId);
    const keyframe = path.keyframes[index];
    if (!keyframe) return openKeyframeMenu(player, opts);

    // Highlight the selected keyframe while this detail screen is open.
    startPathVisualization(player, replayId, () => index);

    const easingLabel = EASING_LABELS[EASING_OPTIONS.indexOf(keyframe.easing)] ?? keyframe.easing;
    const hasIncomingTransition = index > 0;
    const isCurve = keyframe.pathType === "curve";

    const form = new ActionFormData()
        .title(`§6Keyframe #${index + 1}`)
        .body(
            `§7Position: §9x:${round1(keyframe.location.x)} y:${round1(keyframe.location.y)} z:${round1(keyframe.location.z)}\n` +
            `§r§8Replay moment: §9${(keyframe.timelineTick / 20).toFixed(1)}s\n` +
            `§r§8Transition: §9${(keyframe.holdTicks / 20).toFixed(1)}s §8• §9${easingLabel}\n` +
            `§r§8Camera path: §9${hasIncomingTransition ? (isCurve ? "Smooth Curve" : "Straight") : "Start"}`
        )
        .button(playing ? "§3🡆 Jump Here (camera + timeline)" : "§8🡆 Jump Here (needs a replay playing)")
        .button("§3📍 Move Camera Here")
        .button("§3Adjust Timing / Easing");

    if (hasIncomingTransition) {
        form.button("§d＋ Curve Here\n§r§8Stand where you want the bend");
        if (isCurve) {
            form.button("§8↺ Clear Curve\n§r§8Return to a straight path");
        }
    }

    form
        .button(index > 0 ? "§3↑ Move Earlier" : "§8↑ Move Earlier (already first)")
        .button(index < path.keyframes.length - 1 ? "§3↓ Move Later" : "§8↓ Move Later (already last)")
        .button("§4Delete Keyframe")
        .button("§3« Back");

    premiumSection(form, "KEYFRAME EDITOR", `Keyframe #${index + 1}`);
    const response = await form.show(player);
    if (response.canceled) {
        resumeOrStopVisualization(player, opts);
        return;
    }

    if (response.selection === 0) {
        if (!playing) return openKeyframeDetailMenu(player, index, opts);
        try {
            player.teleport(keyframe.location, {
                rotation: { x: keyframe.rotation.pitch, y: keyframe.rotation.yaw }
            });
        } catch (e) {}
        seekTo(keyframe.timelineTick);
        player.sendMessage(`§a✔ Jumped to keyframe §9${index + 1}§a at §9${(keyframe.timelineTick / 20).toFixed(1)}s§a.`);
        return openKeyframeDetailMenu(player, index, opts);
    }

    if (response.selection === 1) {
        const { currentTick } = playing ? getProgress() : { currentTick: keyframe.timelineTick };
        const armorSnapshot = snapshotActorArmor(replayId);
        pushUndoSnapshot(player.id, replayId, path.keyframes);
        updateKeyframeLocation(
            player.id,
            replayId,
            index,
            player.getHeadLocation(),
            player.getRotation(),
            currentTick,
            armorSnapshot
        );
        player.sendMessage(`§a✔ Keyframe §9${index + 1}§a moved to your current position${playing ? " and moment" : ""}.`);
        return openKeyframeDetailMenu(player, index, opts);
    }

    if (response.selection === 2) {
        return openTimingMenu(player, index, opts);
    }

    // Curve Here / Clear Curve are deliberately the only path-editing
    // controls exposed in the simplified editor. Existing advanced path
    // data remains playback-compatible but is no longer presented as a
    // complicated editing workflow.
    let cursor = 3;
    if (hasIncomingTransition) {
        if (response.selection === cursor) {
            pushUndoSnapshot(player.id, replayId, path.keyframes);
            setKeyframeCurveHere(player.id, replayId, index, player.getHeadLocation());
            player.sendMessage(`§a✔ Curve control for keyframe §9${index + 1}§a set to your current position.`);
            return openKeyframeDetailMenu(player, index, opts);
        }
        cursor += 1;

        if (isCurve) {
            if (response.selection === cursor) {
                pushUndoSnapshot(player.id, replayId, path.keyframes);
                clearKeyframeCurve(player.id, replayId, index);
                player.sendMessage(`§7Curve cleared for keyframe §9${index + 1}§7.`);
                return openKeyframeDetailMenu(player, index, opts);
            }
            cursor += 1;
        }
    }

    if (response.selection === cursor) {
        if (index > 0) {
            pushUndoSnapshot(player.id, replayId, path.keyframes);
            moveKeyframe(player.id, replayId, index, -1);
        }
        return openKeyframeMenu(player, opts);
    }

    if (response.selection === cursor + 1) {
        if (index < path.keyframes.length - 1) {
            pushUndoSnapshot(player.id, replayId, path.keyframes);
            moveKeyframe(player.id, replayId, index, 1);
        }
        return openKeyframeMenu(player, opts);
    }

    if (response.selection === cursor + 2) {
        pushUndoSnapshot(player.id, replayId, path.keyframes);
        removeKeyframe(player.id, replayId, index);
        player.sendMessage(`§7Keyframe §9${index + 1}§7 deleted.`);
        return openKeyframeMenu(player, opts);
    }

    if (response.selection === cursor + 3) {
        return openKeyframeMenu(player, opts);
    }
}

async function openTimingMenu(player, index, opts = {}) {
    const replayId = isPlaying() ? getPlayingReplayId() : undefined;
    const path = getPath(player.id, replayId);
    const keyframe = path.keyframes[index];
    if (!keyframe) return openKeyframeMenu(player, opts);

    const form = new ModalFormData()
        .title(`Keyframe #${index + 1} Timing`)
        .slider("Transition duration (ticks)", 2, 200, { valueStep: 1, defaultValue: keyframe.holdTicks })
        .dropdown("Easing", EASING_LABELS, { defaultValueIndex: Math.max(0, EASING_OPTIONS.indexOf(keyframe.easing)) });

    premiumSection(form, "KEYFRAME EDITOR", `Keyframe #${index + 1} Timing`);
    const response = await form.show(player);
    if (response.canceled) { resumeOrStopVisualization(player, opts); return; }

    const [holdTicks, easingIndex] = response.formValues;
    pushUndoSnapshot(player.id, replayId, path.keyframes);
    updateKeyframeTiming(player.id, replayId, index, holdTicks, EASING_OPTIONS[easingIndex]);
    player.sendMessage(`§a✔ Keyframe §9${index + 1}§a timing updated.`);
    return openKeyframeDetailMenu(player, index, opts);
}



/**
 * Closing a nested keyframe editor from standalone Manual Camera must not
 * silently disable the in-world path guide while the seven Manual Camera
 * sticks are still active. Replay-scoped editors still stop visualization
 * normally when their form is closed.
 */
function resumeOrStopVisualization(player, opts = {}) {
    if (opts.standalone && isInManualStickMode(player.id)) {
        startPathVisualization(player, undefined, () => undefined);
    } else {
        stopPathVisualization(player);
    }
}

function round1(n) {
    return Math.round(n * 10) / 10;
}
