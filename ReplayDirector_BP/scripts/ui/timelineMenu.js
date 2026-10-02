import { premiumSection, premiumActive, premiumDisabled, premiumPrimary, premiumSecondary, premiumDanger, premiumBack, premiumLabel, premiumBody, premiumProgressBar } from "./theme.js";
/**
 * Replay Director - Timeline (Phase 3E core, navigation moved in stabilization pass)
 *
 * No longer a main-menu section - only reachable while a specific replay
 * is playing (Replay > Replay List > select a replay > Play Replay lands
 * here directly). Scrubbing and speed use ModalFormData sliders/dropdowns
 * since Bedrock's UI has no live-drag timeline widget - this is the
 * closest native equivalent (pick a position/speed, submit, it jumps/
 * changes instantly).
 */

import { ActionFormData, ModalFormData } from "@minecraft/server-ui";
import {
    isPlaying,
    isPaused,
    getProgress,
    getSpeed,
    setSpeed,
    pausePlayback,
    resumePlayback,
    restartPlayback,
    seekTo,
    skip,
    stopPlayback,
    getPlayingReplayId,
    SPEED_OPTIONS
} from "../replay/playback.js";
import { getReplay } from "../replay/storage.js";
import { getPath } from "../manualCamera/pathState.js";
import { openReplayListMenu } from "./replayListMenu.js";
import { openDirectorControlsMenu } from "./directorControlsMenu.js";

const SKIP_TICKS = 100; // 5 seconds at 20 tps

/**
 * @param {import("@minecraft/server").Player} player
 * @param {{standalone?: boolean}} [opts] - kept for call-site compatibility (stick entry points still pass this) but no longer changes behavior here: every screen's X/Escape always just closes the menu now, and the labeled "« Back" button always navigates, regardless of how this screen was reached.
 */
export async function openTimelineMenu(player, opts = {}) {
    if (!isPlaying()) {
        const form = new ActionFormData()
            .title("§6§lTimeline")
            .body("§7Nothing is playing right now. Start a replay from Replay > Replay List.")
            .button("§3« Back");
        premiumSection(form, "TIMELINE", "Timeline");
    const response = await form.show(player);
        if (response.canceled) return;
        return openReplayListMenu(player);
    }

    const replayId = getPlayingReplayId();
    const record = getReplay(replayId);
    const { currentTick, totalTicks } = getProgress();
    const paused = isPaused();
    const speed = getSpeed();

    const currentSec = (currentTick / 20).toFixed(1);
    const totalSec = (totalTicks / 20).toFixed(1);
    const percent = totalTicks > 0 ? Math.round((currentTick / totalTicks) * 100) : 0;
    const keyframeCount = getPath(player.id, replayId).keyframes.length;
    const eventCount = record && record.eventSummary
        ? Object.values(record.eventSummary).reduce((sum, count) => sum + Number(count || 0), 0)
        : 0;

    const form = new ActionFormData()
        .title("§6§lTimeline")
        .body(
            `§7${record ? record.name : "(unknown)"}\n` +
            `§f${premiumProgressBar(percent)} §9${percent}%\n` +
            `§7Playhead  §f${currentSec}s §8/ §7${totalSec}s   §7Speed §9${speed}x\n` +
            `§7State     ${paused ? "§c● PAUSED" : "§a● PLAYING"}\n` +
            `§7Path      §d${keyframeCount} keyframe${keyframeCount === 1 ? "" : "s"}\n` +
            `§7Events    §9${eventCount}`
        )
        .button(paused ? premiumActive("Resume Playback") : "§5⏸ Pause Playback")
        .button("§3⟲ Restart")
        .button("§3« Skip Back 5s")
        .button("§3» Skip Forward 5s")
        .button("§3Scrub Timeline…")
        .button("§3Playback Speed…")
        .button("§3Director Controls\n§r§8Presets • Manual Camera • Keyframes")
        .button("§4■ Stop Replay")
        .button("§3« Back to Replay List");

    premiumSection(form, "TIMELINE", "Timeline");
    const response = await form.show(player);
    if (response.canceled) return;

    switch (response.selection) {
        case 0:
            if (paused) {
                resumePlayback();
                player.sendMessage("§a▶ Resumed.");
            } else {
                pausePlayback();
                player.sendMessage("§5⏸ Paused.");
            }
            return openTimelineMenu(player, opts);
        case 1:
            restartPlayback();
            player.sendMessage("§7⟲ Restarted from the beginning.");
            return openTimelineMenu(player, opts);
        case 2:
            skip(-SKIP_TICKS);
            return openTimelineMenu(player, opts);
        case 3:
            skip(SKIP_TICKS);
            return openTimelineMenu(player, opts);
        case 4:
            return openScrubMenu(player, totalTicks, opts);
        case 5:
            return openSpeedMenu(player, opts);
        case 6:
            return openDirectorControlsMenu(player);
        case 7:
            stopPlayback();
            player.sendMessage("§7■ Replay stopped.");
            return openReplayListMenu(player);
        case 8:
            return openReplayListMenu(player);
    }
}

async function openScrubMenu(player, totalTicks, opts = {}) {
    if (!isPlaying()) return openTimelineMenu(player, opts);

    const { currentTick } = getProgress();
    const currentPercent = totalTicks > 0 ? Math.round((currentTick / totalTicks) * 100) : 0;

    const form = new ModalFormData().title("Scrub to Position").slider("Position (%)", 0, 100, { valueStep: 1, defaultValue: currentPercent });

    premiumSection(form, "TIMELINE", "Scrub to Position");
    const response = await form.show(player);
    if (response.canceled) return;

    const [percent] = response.formValues;
    if (isPlaying()) {
        seekTo(Math.round((percent / 100) * totalTicks));
        player.sendMessage(`§7Jumped to ${percent}%.`);
    }
    return openTimelineMenu(player, opts);
}

async function openSpeedMenu(player, opts = {}) {
    if (!isPlaying()) return openTimelineMenu(player, opts);

    const currentSpeed = getSpeed();
    const labels = SPEED_OPTIONS.map((s) => `${s}x`);
    const defaultIndex = SPEED_OPTIONS.indexOf(currentSpeed);

    const form = new ModalFormData()
        .title("Playback Speed")
        .dropdown("Speed", labels, { defaultValueIndex: defaultIndex >= 0 ? defaultIndex : labels.indexOf("1x") });

    premiumSection(form, "TIMELINE", "Playback Speed");
    const response = await form.show(player);
    if (response.canceled) return;

    const [index] = response.formValues;
    if (isPlaying()) {
        setSpeed(SPEED_OPTIONS[index]);
        player.sendMessage(`§7Speed set to ${SPEED_OPTIONS[index]}x.`);
    }
    return openTimelineMenu(player, opts);
}
