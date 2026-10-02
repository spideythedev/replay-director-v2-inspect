import { premiumSection, premiumActive, premiumDisabled, premiumPrimary, premiumSecondary, premiumDanger, premiumBack, premiumLabel, premiumBody } from "./theme.js";
/**
 * Replay Director - Replay Detail (Phase 3D)
 *
 * Play Replay is real now: it spawns replay_actor entities and drives them
 * from the recorded frame data. Toggling the same button again while this
 * replay is playing stops it early.
 */

import { ActionFormData, ModalFormData } from "@minecraft/server-ui";
import { getReplay, renameReplay, duplicateReplay, deleteReplay } from "../replay/storage.js";
import { playReplay, stopPlayback, isPlaying, getPlayingReplayId } from "../replay/playback.js";
import { openReplayListMenu } from "./replayListMenu.js";
import { openReplayEditorMenu } from "./replayEditorMenu.js";
import { openTimelineMenu } from "./timelineMenu.js";
import { clearPathsForReplay } from "../manualCamera/pathState.js";
import { clearHistoryForReplay } from "../manualCamera/keyframeHistory.js";

const PLAY_FAIL_MESSAGES = {
    already_playing: "§cA replay is already playing - stop it first.",
    recording_active: "§cCan't play a replay while recording is in progress.",
    not_found: "§cThat replay no longer exists.",
    no_frame_data: "§cThis replay's frame data isn't available this session (it isn't persisted across restarts yet).",
    no_actors: "§cNone of this replay's actors could be spawned."
};

/**
 * @param {import("@minecraft/server").Player} player
 * @param {string} replayId
 */
export async function openReplayDetailMenu(player, replayId) {
    const record = getReplay(replayId);
    if (!record) {
        player.sendMessage("§cThat replay no longer exists.");
        return openReplayListMenu(player);
    }

    const seconds = (record.frameCount / 20).toFixed(1);
    const date = new Date(record.createdAt);
    const kb = (record.approxBytes / 1024).toFixed(1);
    const playingThis = getPlayingReplayId() === replayId;
    const eventsLine = formatEventSummary(record.eventSummary);
    // Record & Replay Mobs pass: read-only summary line, no edit screen for
    // v1 (per the feature request's own suggestion for a first pass) -
    // record.mobs defaults to [] for every replay (including ones saved
    // before this feature existed), so this is always safe to read.
    const mobCount = (record.mobs || []).length;

    const form = new ActionFormData()
        .title(`§6${record.name}`)
        .body(
            `§7Duration: §9${seconds}s\n§r§8Players: §9${record.playerCount}\n§r§8Recorded: §9${date.toString()}\n§r§8Stored entries: §9${record.entryCount}§7 (~${kb} KB)` +
                (mobCount > 0 ? `\n§r§8Mobs recorded: §9${mobCount}` : "") +
                (eventsLine ? `\n§r§8Events: §9${eventsLine}` : "") +
                (playingThis ? "\n§c● Currently playing" : "")
        )
        .button(playingThis ? "§4Stop Replay" : "§aPlay Replay")
        .button("§2Rename")
        .button("§2Duplicate")
        .button("§4Delete")
        .button("§3Edit Replay")
        .button("§3« Back");

    premiumSection(form, "REPLAY", "Replay");
    const response = await form.show(player);
    if (response.canceled) return;

    switch (response.selection) {
        case 0:
            if (playingThis) {
                stopPlayback();
                player.sendMessage("§7■ Replay stopped.");
                return openReplayDetailMenu(player, replayId);
            } else {
                const result = await playReplay(player, replayId);
                if (result.started) {
                    player.sendMessage("§a▶ Replay playing.");
                    return openTimelineMenu(player);
                }
                player.sendMessage(PLAY_FAIL_MESSAGES[result.reason] ?? "§cCouldn't play this replay.");
                return openReplayDetailMenu(player, replayId);
            }
        case 1:
            return renameFlow(player, replayId);
        case 2: {
            const copy = duplicateReplay(replayId);
            player.sendMessage(copy ? `§a✔ Duplicated as §b${copy.name}§a.` : "§cCouldn't duplicate.");
            return openReplayListMenu(player);
        }
        case 3:
            return deleteFlow(player, replayId, record.name);
        case 4:
            return openReplayEditorMenu(player, replayId);
        case 5:
            return openReplayListMenu(player);
    }
}

function formatEventSummary(eventSummary) {
    if (!eventSummary) return undefined;
    const parts = Object.entries(eventSummary).map(([type, count]) => `${count} ${type.replace(/_/g, " ")}`);
    return parts.length > 0 ? parts.join(", ") : undefined;
}

async function renameFlow(player, replayId) {
    const record = getReplay(replayId);
    if (!record) return openReplayListMenu(player);

    const form = new ModalFormData().title("Rename Replay").textField("New name", record.name, { defaultValue: record.name });
    premiumSection(form, "REPLAY", "Replay");
    const response = await form.show(player);
    if (response.canceled) return;

    const [newName] = response.formValues;
    if (newName && newName.trim().length > 0) {
        renameReplay(replayId, newName.trim());
        player.sendMessage(`§a✔ Renamed to §b${newName.trim()}§a.`);
    }
    return openReplayDetailMenu(player, replayId);
}

async function deleteFlow(player, replayId, name) {
    if (getPlayingReplayId() === replayId) {
        player.sendMessage("§cStop the replay before deleting it.");
        return openReplayDetailMenu(player, replayId);
    }

    const form = new ActionFormData()
        .title("Delete Replay")
        .body(`§cAre you sure you want to delete "${name}"? This can't be undone.`)
        .button("§4Delete")
        .button("§4Cancel");

    premiumSection(form, "REPLAY", "Replay");
    const response = await form.show(player);
    if (response.canceled || response.selection === 1) {
        return openReplayDetailMenu(player, replayId);
    }

    deleteReplay(replayId);
    clearPathsForReplay(replayId);
    clearHistoryForReplay(replayId);
    player.sendMessage(`§a✔ Deleted "${name}".`);
    return openReplayListMenu(player);
}
