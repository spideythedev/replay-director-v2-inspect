import { premiumSection, premiumActive, premiumDisabled, premiumPrimary, premiumSecondary, premiumDanger, premiumBack, premiumLabel, premiumBody } from "./theme.js";
/**
 * Replay Director - Replay Menu
 *
 * Start Recording snapshots a bounded region of blocks around the
 * director (Structure Manager) and starts tracking entity spawns/deaths
 * in that region. Stop Recording never restores the world right away -
 * it's left exactly as recording left it, and the snapshot instead
 * restores automatically the next time this specific replay is actually
 * played (see playback.js).
 */

import { ActionFormData } from "@minecraft/server-ui";
import { startRecording, stopRecording, isRecording, getElapsedTicks, WARNING_TICK_THRESHOLD } from "../replay/capture.js";
import { beginSnapshot, restoreSnapshot, deleteDeferredSnapshotStructure } from "../replay/snapshot.js";
import { startEventCapture, stopEventCapture } from "../replay/events.js";
import { saveReplayFromRecording, attachEvents, persistRecordedFrameData, allocateReplayId, MAX_SAVED_REPLAYS } from "../replay/storage.js";
import { isPlaying } from "../replay/playback.js";
import { openMainMenu } from "./mainMenu.js";
import { openReplayListMenu } from "./replayListMenu.js";
import { openPlaybackSettingsMenu } from "./playbackSettingsMenu.js";

/**
 * Icon pass: same fix as mainMenu.js - the earlier vanilla item paths
 * (textures/items/totem, redstone, etc.) rendered as missing-texture
 * checkerboards for some players, so every icon here is now a small
 * custom PNG shipped in this RP (textures/items/*_icon.png) and
 * referenced by its exact path, removing any dependency on vanilla item
 * texture naming.
 */
const ICON_START_RECORDING = "textures/items/start_recording_icon";
const ICON_STOP_RECORDING = "textures/items/stop_recording_icon";
const ICON_REPLAY_LIST = "textures/items/replay_list_icon";
const ICON_PLAYBACK_SETTINGS = "textures/items/playback_settings_icon";

/**
 * @param {import("@minecraft/server").Player} player
 */
export async function openReplayMenu(player) {
    const recording = isRecording();
    const elapsed = recording ? getElapsedTicks() : 0;
    const longRunning = recording && elapsed >= WARNING_TICK_THRESHOLD;

    const form = new ActionFormData()
        .title("§6§lReplay")
        .body(
            recording
                ? `§c● Recording in progress...\n§r§8Blocks/entities within ~62 blocks of where you started will restore automatically the next time you play this replay.${longRunning ? `\n§5⚠ This has been running ${(elapsed / 1200).toFixed(1)} minutes - consider wrapping up soon.` : ""}`
                : `§7Start Recording snapshots the world around you and captures player state. Stop Recording saves the replay and leaves the world as-is - it'll restore automatically when you play this replay back.`
        )
        .button(recording ? "§2Start Recording (recording)" : "§aStart Recording", ICON_START_RECORDING)
        .button(recording ? "§3Stop Recording" : "§8Stop Recording (idle)", ICON_STOP_RECORDING)
        .button("§3Replay List", ICON_REPLAY_LIST)
        .button("§3Playback Settings", ICON_PLAYBACK_SETTINGS)
        .button("§3« Back");

    premiumSection(form, "REPLAY", "Replay");
    const response = await form.show(player);
    if (response.canceled) return;

    switch (response.selection) {
        case 0: {
            if (recording) {
                player.sendMessage("§cAlready recording.");
            } else if (isPlaying()) {
                player.sendMessage("§cCan't start recording while a replay is playing - stop the replay first.");
            } else {
                // Allocated up front (not at save time, like before) so the
                // snapshot's structure can be named after this replay's
                // real id right away - see beginSnapshot's replayId param.
                const allocated = allocateReplayId();
                // Capture the 62x62x62 pre-recording world first. Recording
                // starts only after every snapshot tile has been saved, so
                // the first recorded tick can never race snapshot capture.
                const snapshot = await beginSnapshot(player, allocated.id);
                const started = startRecording(player, allocated);
                if (started) {
                    startEventCapture();
                    player.sendMessage(
                        snapshot.ok
                            ? "§a● Recording started - world snapshot captured."
                            : `§a● Recording started.\n§5⚠ World snapshot failed - blocks won't auto-restore (entity tracking still active).${
                                  snapshot.reason ? `\n§r§8Reason: §9${snapshot.reason}` : ""
                              }`
                    );
                } else {
                    const abandonedSnapshot = restoreSnapshot();
                    if (abandonedSnapshot.deferred) {
                        deleteDeferredSnapshotStructure(abandonedSnapshot.deferred.structureIds || abandonedSnapshot.deferred.structureId);
                    }
                    player.sendMessage("§cCouldn't start recording.");
                }
            }
            return openReplayMenu(player);
        }
        case 1: {
            if (!recording) {
                player.sendMessage("§cNot currently recording.");
                return openReplayMenu(player);
            }
            const stats = stopRecording();
            if (stats) {
                const restore = restoreSnapshot();
                const events = stopEventCapture();
                const { record, atOrOverCap } = saveReplayFromRecording(stats, stats.allocated, restore.deferred);
                attachEvents(record.id, events);
                const persisted = await persistRecordedFrameData(record.id);
                const kb = (stats.approxBytes / 1024).toFixed(1);

                let message = `§a■ Recording stopped and saved as §b${record.name}§a.\n§r§8Ticks: §9${stats.frameCount}§7  Players: §9${stats.playerCount}§7  ~Size: §9${kb} KB§7  World events: §9${events.length}`;
                message += persisted && persisted.ok
                    ? `\n§r§8This replay will survive a world restart.`
                    : `\n§5⚠ This replay will NOT survive a world restart (still fully playable this session)${persisted && persisted.reason === "budget_exceeded" ? " - persistent storage budget reached." : "."}`;
                message += restore.deferred && restore.deferred.blocksSnapshotted
                    ? `\n§r§8World left as-is - it'll restore automatically the next time you play this replay.`
                    : `\n§5⚠ No block snapshot was captured for this recording, so there'll be nothing to restore when you play it back.`;
                if (atOrOverCap) {
                    message += `\n§r§8(You have more than ${MAX_SAVED_REPLAYS} saved replays now - nothing was deleted automatically. Delete old ones from Replay List when you're ready.)`;
                }

                player.sendMessage(message);
            }
            return openReplayMenu(player);
        }
        case 2:
            return openReplayListMenu(player);
        case 3:
            return openPlaybackSettingsMenu(player);
        case 4:
            return openMainMenu(player);
    }
}
