/**
 * Replay Director - Entry Point
 * Phase 3I: core foundation + startup crash-recovery cleanup
 *
 * Item-registration fix pass: every Director tool is now a plain,
 * unmodified vanilla `minecraft:stick`, distinguished only by its
 * ItemStack.nameTag (a real, documented ItemStack property - see
 * MAIN_STICK_NAME/STICK_NAMES below). There is no custom item JSON and no
 * registerCustomComponent call left anywhere in this add-on - that whole
 * mechanism (and its "deprecated minecraft:custom_components" / "missing
 * icon" Content Log errors, which came from custom item definitions that
 * needed their own icon/component wiring) is gone because there's no
 * custom item left to define. Detection instead uses
 * world.afterEvents.itemUse, a normal vanilla event that fires for ANY
 * item any player uses, filtered here by nameTag - a vanilla stick with no
 * nameTag set (an ordinary stick from a player's own inventory) never
 * matches and is left completely alone.
 *
 * Ash Blast
 */

import { system, world } from "@minecraft/server";
import { openMainMenu } from "./ui/mainMenu.js";
import { cancelShot, handleDirectorDisconnect } from "./camera/cameraRunner.js";
import { unfreezeTargetById } from "./camera/freeze.js";
import { restoreHudOnRejoin } from "./camera/cameraRunner.js";
import { getSession, clearSession } from "./core/state.js";
import { MAIN_STICK_NAME, STICK_NAMES, createDirectorToolStick } from "./core/directorSticks.js";
import { setReplayDebugEnabled } from "./core/debugLog.js";
import { isRecording, stopRecording } from "./replay/capture.js";
import { recordingState } from "./replay/recordingState.js";
import { stopEventCapture } from "./replay/events.js";
import { restoreSnapshot } from "./replay/snapshot.js";
import {
    saveReplayFromRecording,
    attachEvents,
    persistRecordedFrameData
} from "./replay/storage.js";
import { isPlaying, getPlaybackDirector, stopPlayback } from "./replay/playback.js";

import {
    useStickPause,
    useStickAddKeyframe,
    useStickSpeed,
    useStickPresets,
    useStickTimeline,
    useStickGamemode,
    useStickStop,
    useStickSkinCycle
} from "./ui/stickMenu.js";
import { MANUAL_STICK_NAMES, isInManualStickMode, exitManualStickMode } from "./manualCamera/manualCameraSticks.js";
import { stopPathVisualization } from "./manualCamera/pathVisualizer.js";
import { restoreViewingModeOnRejoin } from "./core/viewingMode.js";
import {
    useManualStickAddKeyframe,
    useManualStickManageKeyframes,
    useManualStickPlayAnimation,
    useManualStickClearPath,
    useManualStickExit,
    useManualStickUndo,
    useManualStickRedo,
    useManualStickCurveHere,
    useManualStickCurveToggle
} from "./ui/manualCameraStickMenu.js";

/** nameTag -> handler, for the 7 in-playback Director Sticks. Every one of these is given/removed automatically by viewingMode.js during playback - a player is never expected to source these from creative/survival themselves. */
const STICK_HANDLERS = new Map([
    [STICK_NAMES.pause, useStickPause],
    [STICK_NAMES.speed, useStickSpeed],
    [STICK_NAMES.presets, useStickPresets],
    [STICK_NAMES.keyframe, useStickAddKeyframe],
    [STICK_NAMES.timeline, useStickTimeline],
    [STICK_NAMES.gamemode, useStickGamemode],
    [STICK_NAMES.stop, useStickStop],
    [STICK_NAMES.skinCycle, useStickSkinCycle]
]);

/** nameTag -> handler, for the 9 Manual Camera Mode controls. Deliberately a SEPARATE map from STICK_HANDLERS above (not merged into it) - these are given/removed by manualCameraSticks.js, only while no replay is playing (see that file's header), and dispatched independently here so a change to either stick set can never affect the other's lookup. */
const MANUAL_STICK_HANDLERS = new Map([
    [MANUAL_STICK_NAMES.addKeyframe, useManualStickAddKeyframe],
    [MANUAL_STICK_NAMES.manageKeyframes, useManualStickManageKeyframes],
    [MANUAL_STICK_NAMES.playAnimation, useManualStickPlayAnimation],
    [MANUAL_STICK_NAMES.clearPath, useManualStickClearPath],
    [MANUAL_STICK_NAMES.exit, useManualStickExit],
    [MANUAL_STICK_NAMES.undo, useManualStickUndo],
    [MANUAL_STICK_NAMES.redo, useManualStickRedo],
    [MANUAL_STICK_NAMES.curveHere, useManualStickCurveHere],
    [MANUAL_STICK_NAMES.curveToggle, useManualStickCurveToggle]
]);

function handleMainStickTrigger(player) {
    if (!player || player.typeId !== "minecraft:player") return;

    const session = getSession(player.id);
    if (session.active) {
        // Stick used again while a cinematic is running: cancel it.
        cancelShot(player);
        player.sendMessage("§c✖ Cinematic canceled.");
        return;
    }

    // Defer the UI open by a tick - opening a form directly inside
    // an item-use event can occasionally be swallowed on some clients.
    system.run(() => {
        if (player.isValid) openMainMenu(player);
    });
}

/** Same one-tick deferral as handleMainStickTrigger, for the same reason - applies equally to the instant-action sticks (pause/resume, add keyframe, stop), since it's item-use timing that matters here, not whether a form gets shown. */
function runStickAction(player, action) {
    if (!player || player.typeId !== "minecraft:player") return;
    system.run(() => {
        if (player.isValid) action(player);
    });
}

world.afterEvents.itemUse.subscribe((event) => {
    const player = event.source;
    const nameTag = event.itemStack ? event.itemStack.nameTag : undefined;
    if (!nameTag) return;

    if (nameTag === MAIN_STICK_NAME) {
        handleMainStickTrigger(player);
        return;
    }

    const handler = STICK_HANDLERS.get(nameTag);
    if (handler) {
        runStickAction(player, handler);
        return;
    }

    const manualHandler = MANUAL_STICK_HANDLERS.get(nameTag);
    if (manualHandler) {
        runStickAction(player, manualHandler);
    }
});

// Fallback / debug trigger: /scriptevent replay:menu
// Equipment-pipeline debug toggle: /scriptevent replay:debug on|off
// Obtain the Director Stick: /scriptevent replay:give
system.afterEvents.scriptEventReceive.subscribe(
    (event) => {
        if (event.id === "replay:debug") {
            const arg = (event.message || "").trim().toLowerCase();
            setReplayDebugEnabled(arg !== "off");
            return;
        }
        if (event.id === "replay:give") {
            if (!event.sourceEntity || event.sourceEntity.typeId !== "minecraft:player") return;
            giveDirectorStick(event.sourceEntity);
            return;
        }
        if (event.sourceEntity && event.sourceEntity.typeId === "minecraft:player") {
            handleMainStickTrigger(event.sourceEntity);
        }
    },
    { namespaces: ["replay"] }
);

/**
 * Gives the requesting player one main Director Stick, unless they
 * already carry one (checked by nameTag across their inventory, same
 * check the old auto-give-on-spawn logic used) - running the command
 * again with one already in hand is a harmless no-op message, not a
 * duplicate stick.
 * @param {import("@minecraft/server").Player} player
 */
function giveDirectorStick(player) {
    try {
        const inventoryComponent = player.getComponent("minecraft:inventory");
        const container = inventoryComponent ? inventoryComponent.container : undefined;
        if (!container) {
            player.sendMessage("§cCouldn't access your inventory - try again.");
            return false;
        }

        for (let i = 0; i < container.size; i++) {
            const item = container.getItem(i);
            if (item && item.typeId === "minecraft:stick" && item.nameTag === MAIN_STICK_NAME) {
                return true;
            }
        }

        const remaining = container.addItem(createDirectorToolStick(MAIN_STICK_NAME, true));
        // Container.addItem() returns undefined when the entire stack was
        // inserted successfully. A returned ItemStack means some/all of the
        // stack could not be inserted. The previous check inverted this
        // contract, so a successful add was reported as "inventory full".
        if (remaining) {
            player.sendMessage("§eReplay Director is ready, but your inventory is full. Make one slot available and rejoin/respawn to receive the tool.");
            return false;
        }
        return true;
    } catch (e) {
        player.sendMessage("§cCouldn't add the Replay Director tool - try again.");
        return false;
    }
}

// The main Director stick is intentionally available in every supported
// player gamemode. It is a plain named vanilla stick, so no cheats, operator
// permission, /give, or /scriptevent command is required to open the UI.
// The spawn handler below gives it only when the player does not already have
// one, so normal Survival/Hardcore/Creative play is not repeatedly polluted
// with duplicate tools.

// Phase 3I: crash-recovery safety net. If the world was previously closed
// while a replay/playback was active, its actor entities and any temporary
// event-playback mobs never got cleaned up normally. Run the same cleanup
// once, automatically, a tick after the world is ready - across every
// standard dimension, since a previous session could have been anywhere.
//
// Item-registration fix pass: leftover Director Sticks are now plain named
// vanilla sticks, not a custom item type, so they can't be targeted by
// item identifier with /clear the way the old custom items were. There is
// no confirmed vanilla selector for "a stick with this specific nameTag"
// to clear automatically, so a crashed session's sticks are left in the
// director's inventory (indistinguishable from any other named stick they
// might be carrying for an unrelated reason) rather than guessing at a
// clear command that could just as easily delete a normal stick the
// player renamed themselves. As before, the inventory/gamemode snapshot
// itself can't be recovered after a restart either - see viewingMode.js.
system.run(() => {
    for (const dimensionId of ["overworld", "nether", "the_end"]) {
        try {
            world.getDimension(dimensionId).runCommand("kill @e[family=replay_actor]");
            world.getDimension(dimensionId).runCommand("kill @e[tag=replay:temp_mob]");
        } catch (e) {
            // fail soft - a dimension with nothing to clean up is expected, not an error
        }
    }
});

// Polish pass: per-player rejoin safety net. If a director disconnected
// mid-cinematic (input frozen via freeze.js's InputPermissionCategory
// calls, and/or HUD hidden via cameraRunner.js's setHudVisibility), the
// normal cleanup path never ran for them - cleanup() and unfreezeTarget()
// both need a valid Player object to actually call the restoring API, and
// a disconnected player's Player object is invalid for the rest of that
// session (see freeze.js's/cameraRunner.js's own doc comments on
// unfreezeTargetById/restoreHudOnRejoin for the full reasoning). This is
// the confirmed root cause behind "movement sometimes doesn't work" and
// "crosshair stayed visible" reports: once stuck, those input/HUD flags
// stayed permanently altered for that player until the world reloaded.
// Runs on every join (not just after a crash), since a mid-cinematic
// disconnect is an ordinary event this add-on should always recover from,
// not something that requires a world restart to notice. No-ops instantly
// for the overwhelming majority of joins where nothing is actually stuck
// (both functions bail out immediately if this player id isn't tracked).
world.afterEvents.playerLeave.subscribe((event) => {
    const playerId = event.playerId;
    // Manual Camera path particles are editor-only. Stop the redraw loop
    // immediately when its owner disconnects so no stale visualization
    // survives the session.
    try { stopPathVisualization({ id: playerId }); } catch (e) {}

    // If the leaving player owns the active recording, finalize it into the
    // normal replay pipeline instead of leaving recordingState/timers and
    // event subscriptions stranded. No Player object is required for save.
    if (isRecording() && recordingState.startedBy === playerId) {
        try {
            const stats = stopRecording();
            const restore = restoreSnapshot();
            const events = stopEventCapture();
            if (stats && stats.allocated) {
                const { record } = saveReplayFromRecording(stats, stats.allocated, restore.deferred);
                attachEvents(record.id, events);
                void persistRecordedFrameData(record.id).catch(() => {});
            }
        } catch (e) {
            // Last-resort cleanup: stop the recording/event systems even if
            // saving encountered an unexpected runtime error.
            try { if (isRecording()) stopRecording(); } catch (ignore) {}
            try { stopEventCapture(); } catch (ignore) {}
        }
    }

    // A disconnecting playback director has an invalid Player object, so
    // camera APIs cannot be called. End the camera session and stop playback;
    // viewingMode.js intentionally keeps the saved inventory/gamemode snapshot
    // until the same player rejoins.
    const playbackDirector = getPlaybackDirector();
    if (isPlaying() && playbackDirector && playbackDirector.id === playerId) {
        handleDirectorDisconnect(playerId);
        stopPlayback();
    } else {
        // Also cover standalone preset/manual cinematic shots that are not
        // part of replay playback.
        handleDirectorDisconnect(playerId);
    }

    // Clear ordinary cinematic session state for this director. Replay
    // viewing-mode state is deliberately separate and is restored on rejoin.
    clearSession(playerId);
});

world.afterEvents.playerSpawn.subscribe((event) => {
    const player = event.player;
    if (!event.initialSpawn) {
        // In normal Survival, the tool is kept on death. This fallback also
        // covers any unusual inventory loss on respawn without duplicating it.
        giveDirectorStick(player);
        return;
    }
    unfreezeTargetById(player);
    restoreHudOnRejoin(player);
    if (restoreViewingModeOnRejoin(player)) {
        player.sendMessage("§7Your items and game mode from before Replay Director playback have been restored.");
    }

    // Make the Replay Director entry tool available without cheats or operator
    // permission in Survival, Hardcore, and Creative. The helper is idempotent.
    giveDirectorStick(player);

    // Manual Camera Mode Sticks: if this player disconnected while
    // holding the 8 Manual Camera controls, manualCameraSticks.js's
    // in-memory record of their original inventory is still there (same
    // lifetime as everything else in this addon's per-session state - it
    // does NOT survive a full world/server restart, only a normal
    // disconnect/reconnect within the same running session, exactly like
    // viewingMode.js's own equivalent limitation). Restoring here on
    // rejoin is the safest point available: the player's own client
    // already re-synced whatever inventory Bedrock itself persisted
    // (typically the stick-filled one from the moment they left), so
    // this puts their real original items back as soon as there's a
    // valid Player object to do it with again.
    if (isInManualStickMode(player.id)) {
        exitManualStickMode(player);
        player.sendMessage("§7Your items from before Manual Camera Mode have been restored.");
    }
});
