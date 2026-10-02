import { premiumSection, premiumActive, premiumDisabled, premiumPrimary, premiumSecondary, premiumDanger, premiumBack, premiumLabel, premiumBody } from "./theme.js";
/**
 * Replay Director - Director Sticks (Replay Playback Environment pass)
 *
 * One dedicated item per common in-playback action, so filming doesn't
 * mean repeatedly backing out of nested menus. Every stick calls straight
 * into the SAME existing systems the old menu flow used (playback.js,
 * pathState.js, presetsMenu.js, directorControlsMenu.js, timelineMenu.js) -
 * nothing about the replay/camera engines themselves changed for this,
 * only how the director reaches them.
 *
 * Pause/Resume, Add Keyframe, and Stop Replay are genuinely instant (no
 * form shown at all) per the requirements. Speed, Camera Presets,
 * Timeline, and Gamemode open a focused submenu - Timeline reuses the
 * existing Timeline screen as-is; Camera Presets opens Director Controls
 * (Presets / Manual Camera / Keyframes all in one place, see that file);
 * Speed and Gamemode are small dedicated pickers here since the existing
 * Timeline speed menu offers a different (larger) option set than what
 * was asked for on this stick specifically.
 */

import { ActionFormData } from "@minecraft/server-ui";
import { GameMode } from "@minecraft/server";
import { isPlaying, isPaused, pausePlayback, resumePlayback, stopPlayback, getSpeed, setSpeed, getPlaybackDirector, getPlayingReplayId, getProgress, getActiveActors } from "../replay/playback.js";
import { addKeyframe, snapshotActorArmor, getPath, autoCircularThreeKeyframes } from "../manualCamera/pathState.js";
import { pushUndoSnapshot } from "../manualCamera/keyframeHistory.js";
import { setViewingGameMode } from "../core/viewingMode.js";
import { openTimelineMenu } from "./timelineMenu.js";
import { openDirectorControlsMenu } from "./directorControlsMenu.js";
import { openReplayListMenu } from "./replayListMenu.js";
import { openReplayActorMenu } from "./replayActorMenu.js";

const STICK_SPEED_OPTIONS = [0.25, 0.5, 1, 2, 4];

const GAMEMODE_OPTIONS = [
    { label: "§aSurvival", mode: GameMode.Survival },
    { label: "§dCreative", mode: GameMode.Creative }
];

/** @param {import("@minecraft/server").Player} player */
function notPlayingMessage(player) {
    player.sendMessage("§7Nothing is playing right now.");
}

/** Pause/Resume Stick - toggles instantly, no submenu. */
export function useStickPause(player) {
    if (!isPlaying()) return notPlayingMessage(player);

    if (isPaused()) {
        resumePlayback();
        player.sendMessage("§a▶ Resumed.");
    } else {
        pausePlayback();
        player.sendMessage("§5⏸ Paused.");
    }
}

/**
 * Add Keyframe Stick - places a keyframe at the director's current camera
 * position instantly, with a chat confirmation.
 *
 * Replay-scoped Keyframes pass: every keyframe belongs to a specific
 * replay now (see pathState.js), so this stick requires a replay to be
 * playing rather than adding a keyframe with no replay to belong to - the
 * same rule Manual Camera Mode's own "Add Keyframe Here" already follows.
 */
export function useStickAddKeyframe(player) {
    if (!isPlaying()) return notPlayingMessage(player);

    const replayId = getPlayingReplayId();
    const { currentTick } = getProgress();
    const armorSnapshot = snapshotActorArmor(replayId);
    pushUndoSnapshot(player.id, replayId, getPath(player.id, replayId).keyframes);
    const index = addKeyframe(player.id, replayId, player.getHeadLocation(), player.getRotation(), currentTick, armorSnapshot);
    const pathAfterAdd = getPath(player.id, replayId);
    const circleResult = pathAfterAdd.keyframes.length >= 3
        ? autoCircularThreeKeyframes(player.id, replayId)
        : { applied: false };
    player.sendMessage(`§a✔ Keyframe §9${index + 1}§a added at §9${(currentTick / 20).toFixed(1)}s§a into the replay.`);
    if (circleResult.applied) {
        player.sendMessage("§a✔ Smooth curve path updated — it will continue through all keyframes.");
    }
}

/** Playback Speed Stick - opens a small fixed picker (0.25x/0.5x/1x/2x/4x), distinct from Timeline's own larger speed list. */
export async function useStickSpeed(player) {
    if (!isPlaying()) return notPlayingMessage(player);

    const currentSpeed = getSpeed();
    const form = new ActionFormData().title("§6Playback Speed");
    for (const s of STICK_SPEED_OPTIONS) {
        form.button(s === currentSpeed ? `§2${s}x (current)` : `${s}x`);
    }
    form.button("§4« Cancel");

    premiumSection(form, "DIRECTOR CONTROLS", "Playback Speed");
    const response = await form.show(player);
    if (response.canceled || response.selection === STICK_SPEED_OPTIONS.length) return;

    if (isPlaying()) {
        setSpeed(STICK_SPEED_OPTIONS[response.selection]);
        player.sendMessage(`§7Speed set to ${STICK_SPEED_OPTIONS[response.selection]}x.`);
    }
}

/** Camera Presets Stick - opens Director Controls (Presets / Manual Camera / Keyframes together). standalone:true so its own Back button closes the menu instead of opening Timeline, which the player never visited this trip. */
export async function useStickPresets(player) {
    return openDirectorControlsMenu(player, { standalone: true });
}

/** Timeline Stick - opens the existing Timeline screen unchanged. standalone:true so its own Back button closes the menu instead of opening Replay List, which the player never visited this trip. */
export async function useStickTimeline(player) {
    if (!isPlaying()) {
        player.sendMessage("§7Nothing is playing right now - opening Replay List.");
        return openReplayListMenu(player);
    }
    return openTimelineMenu(player, { standalone: true });
}

/**
 * Gamemode Stick - opens Survival/Creative picker. Only usable
 * while the director is actually in viewing mode (i.e. this playback's
 * own director, not just any player) - setViewingGameMode itself enforces
 * that and no-ops otherwise, so a stray/duplicated stick can't be used to
 * gamemode-switch someone who isn't actually directing this playback.
 */
export async function useStickGamemode(player) {
    if (!isPlaying()) return notPlayingMessage(player);

    const director = getPlaybackDirector();
    if (!director || director.id !== player.id) {
        player.sendMessage("§cOnly the director who started this replay can change gamemode with this stick.");
        return;
    }

    const form = new ActionFormData().title("§6Gamemode");
    for (const opt of GAMEMODE_OPTIONS) form.button(opt.label);
    form.button("§4« Cancel");

    premiumSection(form, "DIRECTOR CONTROLS", "Gamemode");
    const response = await form.show(player);
    if (response.canceled || response.selection === GAMEMODE_OPTIONS.length) return;

    const chosen = GAMEMODE_OPTIONS[response.selection];
    if (setViewingGameMode(player, chosen.mode)) {
        player.sendMessage(`§7Gamemode set to ${chosen.label}§7.`);
    } else {
        player.sendMessage("§cCouldn't change gamemode.");
    }
}

/** Stop Replay Stick - stops immediately, no submenu. */
export function useStickStop(player) {
    if (!isPlaying()) return notPlayingMessage(player);
    stopPlayback();
    player.sendMessage("§7■ Replay stopped.");
}

/**
 * Actor Skin Stick - picks one of the currently-playing fake players
 * (Replay Actors), then opens the SAME Replay Actor menu (Skin/Armor/Held
 * Item/Name/Visibility) that Edit Replay already routes into after
 * stopping a replay - not a separate/simplified skin-only flow. This
 * stick is just a faster way to reach that same menu mid-playback,
 * without needing to stop the replay and go through Edit Replay first.
 */
export async function useStickSkinCycle(player) {
    if (!isPlaying()) return notPlayingMessage(player);

    const activeActors = getActiveActors();
    if (activeActors.length === 0) {
        player.sendMessage("§7No fake players are on screen right now.");
        return;
    }

    const replayId = getPlayingReplayId();
    if (!replayId) {
        player.sendMessage("§cCouldn't determine which replay is playing.");
        return;
    }

    const form = new ActionFormData().title("§5Actor Skin");
    for (const { entity } of activeActors) {
        const label = entity.nameTag || entity.id;
        form.button(`§3${label}`);
    }
    form.button("§4« Cancel");

    premiumSection(form, "DIRECTOR CONTROLS", "Actor Skin");
    const response = await form.show(player);
    if (response.canceled || response.selection === activeActors.length) return;

    const { playerId } = activeActors[response.selection];
    return openReplayActorMenu(player, replayId, playerId, { standalone: true });
}
