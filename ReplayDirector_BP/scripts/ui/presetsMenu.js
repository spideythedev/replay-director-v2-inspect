import { premiumSection, premiumActive, premiumDisabled, premiumPrimary, premiumSecondary, premiumDanger, premiumBack, premiumLabel, premiumBody } from "./theme.js";
/**
 * Replay Director - Presets Menu
 *
 * Lists the working presets, lets the director quickly tweak distance/
 * height/countdown, auto-detects the nearest player as the subject, and
 * runs the shot through the camera engine.
 */

import { ActionFormData, ModalFormData } from "@minecraft/server-ui";
import { world } from "@minecraft/server";
import { PRESETS } from "../presets/index.js";
import { findAutoTarget } from "../camera/targeting.js";
import { playShot } from "../camera/cameraRunner.js";
import { isCountdownEnabled } from "../core/settings.js";
import { snapshotSubject, midpointSubject, wrapWithFollow } from "../presets/presetUtils.js";
import { runSpawnShowcase } from "../presets/spawnShowcase.js";
import { HERO_SHOT } from "../presets/heroShot.js";
import { isPlaying, getActiveActors, getPlayingReplayId } from "../replay/playback.js";
import { getReplay } from "../replay/storage.js";
import { openMainMenu } from "./mainMenu.js";
import {
    getFavoriteIds,
    isFavorite,
    toggleFavorite,
    getLastPreset,
    setLastPreset,
    clearLastPreset
} from "../presets/presetLibrary.js";

export { getLastPreset };

const DISTANCE_LABELS = ["near", "medium", "far", "extreme"];
const HEIGHT_LABELS = ["low", "eye", "high", "very_high"];
const TICK_OPTIONS = [20, 40, 60, 80, 100, 120, 160, 200, 400, 800];
const TICK_LABELS = TICK_OPTIONS.map((t) => `${t} ticks (${(t / 20).toFixed(1)}s)`);

/** Finds the tick option closest to a preset's default duration, for the dropdown's starting position. */
function closestTickIndex(durationTicks) {
    let bestIndex = 0;
    let bestDiff = Infinity;
    TICK_OPTIONS.forEach((t, i) => {
        const diff = Math.abs(t - durationTicks);
        if (diff < bestDiff) {
            bestDiff = diff;
            bestIndex = i;
        }
    });
    return bestIndex;
}

const SPECIAL_ENTRIES = [
    { id: "spawn_showcase", label: "§6⭐ Spawn Showcase", sub: "§8Tours the world spawn: Orbit -> Bird's Eye -> Ground -> Hero." },
    { id: "smart_intro", label: "§6⭐ Smart Intro (Beta)", sub: "§8Picks Myself or a two-shot automatically based on who's around." }
];

function presetDisplayColor(preset) {
    return "§3";
}

function getFavoriteEntries(playerId) {
    const ids = new Set(getFavoriteIds(playerId));
    return PRESETS.filter((preset) => ids.has(preset.id));
}

function findPresetEntry(playerId, presetId) {
    return PRESETS.find((preset) => preset.id === presetId);
}

/**
 * @param {import("@minecraft/server").Player} player
 */
export async function openPresetsMenu(player) {
    const last = getLastPreset(player.id);
    const favorites = getFavoriteEntries(player.id);

    const form = new ActionFormData()
        .title("§6§lPresets")
        .body("§7Select a cinematic preset. You'll choose who to focus on next.");

    const actions = [];

    // This is the original Last Preset behavior: only show it once a
    // preset has actually been used, and restore its saved settings when
    // selected.
    if (last) {
        form.button(`§6⚡ Last Preset: ${last.presetName}\n§r§8Open the last-used settings again`);
        actions.push(() => openLastPreset(player, last));
    }

    form.button(`§6★ Favorites (${favorites.length})\n§r§8Your pinned shots`);
    actions.push(() => openPresetCollectionMenu(player, "favorites"));

    const presetOffset = actions.length;

    for (const preset of PRESETS) {
        form.button(`§l${presetDisplayColor(preset)}${isFavorite(player.id, preset.id) ? "★ " : ""}${preset.name}\n§r§8${preset.description}`);
        actions.push(() => openFocusMenu(player, preset));
    }

    for (const special of SPECIAL_ENTRIES) {
        form.button(`${special.label}\n${special.sub}`);
        actions.push(() => special.id === "spawn_showcase" ? runSpawnShowcase(player) : runSmartIntro(player));
    }

    form.button("§3« Back");
    actions.push(() => openMainMenu(player));

    premiumSection(form, "CINEMATIC PRESETS", "Cinematic Presets");
    const response = await form.show(player);
    if (response.canceled) return;

    return actions[response.selection]?.();
}

async function openPresetCollectionMenu(player, type) {
    if (type !== "favorites") return openPresetsMenu(player);

    const entries = getFavoriteEntries(player.id);
    const form = new ActionFormData()
        .title("§6§l★ Favorites")
        .body(entries.length
            ? "§7Choose one of your pinned presets."
            : "§7No favorites yet. Pin a preset from its settings.");

    for (const preset of entries) {
        form.button(`§l§3★ ${preset.name}\n§r§8${preset.description}`);
    }
    form.button("§3« Back");

    premiumSection(form, "PRESET LIBRARY", "★ Favorites");
    const response = await form.show(player);
    if (response.canceled) return;

    if (response.selection < entries.length) {
        return openFocusMenu(player, entries[response.selection]);
    }

    return openPresetsMenu(player);
}

/**
 * A simplified, honest "Smart Intro": it only decides between filming
 * yourself or a two-shot with the nearest other player, based on who's
 * actually around. It does NOT try to detect bases/farms/PvP fights -
 * that would need scanning and classifying the surrounding builds, which
 * isn't reliable enough yet to ship (see chat for why).
 */
export async function openLastPreset(player, last) {
    const preset = findPresetEntry(player.id, last.presetId);
    if (!preset) {
        clearLastPreset(player.id);
        player.sendMessage("§7The previous preset is no longer available.");
        return openPresetsMenu(player);
    }

    const focus = resolveFocus(player, last.focusMode, last.focusTargetId);
    if (!focus) {
        player.sendMessage("§7The last preset's previous subject is no longer available. Choose a subject again.");
        return openFocusMenu(player, preset);
    }

    return openPresetOptionsMenu(
        player,
        preset,
        last.focusMode,
        last.focusTargetId,
        last.options
    );
}

async function runSmartIntro(player) {
    const hasOtherPlayers = !!findAutoTarget(player);
    const focusMode = hasOtherPlayers ? "center" : "self";
    player.sendMessage(
        hasOtherPlayers
            ? "§7Smart Intro: found another player nearby - framing both of you."
            : "§7Smart Intro: nobody else around - filming yourself."
    );
    return openPresetOptionsMenu(player, HERO_SHOT, focusMode);
}

const FOCUS_MODES = [
    { id: "front", label: "§bPlayer In Front (Nearest)", sub: "§8Focuses whoever is nearest to you." },
    { id: "center", label: "§dCenter (Me + Them)", sub: "§8Frames the midpoint between you and the nearest player." },
    { id: "self", label: "§5Myself", sub: "§8Focuses you, the director - a selfie-style shot." }
];

/**
 * @param {import("@minecraft/server").Player} player
 * @param {import("../presets/index.js").PRESETS[number]} preset
 */
async function openFocusMenu(player, preset) {
    const hasOtherPlayers = !!findAutoTarget(player);
    if (preset.requiresTwoPlayers) {
        if (!hasOtherPlayers) {
            player.sendMessage("§7This preset needs another player nearby.");
            return openPresetsMenu(player);
        }
        return openPresetOptionsMenu(player, preset, "center");
    }
    const canFocusActor = isPlaying() && getActiveActors().length > 0;

    if (!hasOtherPlayers && !canFocusActor) {
        // Nothing else to point the camera at - Front/Center need a second
        // player and Replay Actor needs a playing replay, neither of which
        // exist right now, so skip straight to Myself.
        player.sendMessage("§7No other players around - filming yourself.");
        return openPresetOptionsMenu(player, preset, "self");
    }

    const modes = hasOtherPlayers ? [...FOCUS_MODES] : [FOCUS_MODES.find((m) => m.id === "self")];
    if (canFocusActor) {
        modes.push({ id: "replay_actor", label: "§aReplay Actor", sub: "§8Focus one of the actors from the replay currently playing." });
    }

    const form = new ActionFormData().title(`§6${preset.name}`).body("§7Who should the camera focus on?");
    for (const mode of modes) {
        form.button(`${mode.label}\n§r${mode.sub}`);
    }
    form.button("§3« Back");

    premiumSection(form, "CINEMATIC PRESETS", "Choose Shot Focus");
    const response = await form.show(player);
    if (response.canceled) return;

    if (response.selection === modes.length) {
        return openPresetsMenu(player);
    }

    const chosen = modes[response.selection];
    if (chosen.id === "replay_actor") {
        return openActorFocusPicker(player, preset);
    }

    return openPresetOptionsMenu(player, preset, chosen.id);
}

/**
 * @param {import("@minecraft/server").Player} player
 * @param {import("../presets/index.js").PRESETS[number]} preset
 */
async function openActorFocusPicker(player, preset) {
    const activeActors = getActiveActors();
    if (activeActors.length === 0) {
        player.sendMessage("§cNo replay actors are currently active.");
        return openFocusMenu(player, preset);
    }
    if (activeActors.length === 1) {
        return openPresetOptionsMenu(player, preset, "replay_actor", activeActors[0].playerId);
    }

    const record = getReplay(getPlayingReplayId());
    const form = new ActionFormData().title("§6Replay Actor").body("§7Which actor should the camera focus on?");
    for (const active of activeActors) {
        const meta = record ? record.actors.find((a) => a.playerId === active.playerId) : undefined;
        form.button(`§l§3${meta ? meta.displayName : "Replay Actor"}`);
    }
    form.button("§3« Back");

    premiumSection(form, "CINEMATIC PRESETS", "Replay Actor Focus");
    const response = await form.show(player);
    if (response.canceled) return;

    if (response.selection === activeActors.length) {
        return openFocusMenu(player, preset);
    }

    return openPresetOptionsMenu(player, preset, "replay_actor", activeActors[response.selection].playerId);
}

/**
 * Resolves the focus mode into a subject snapshot (for the preset's shot
 * math) and, separately, the real entity to freeze/follow during the shot
 * (may be undefined for center mode's virtual midpoint - the two real
 * players involved still get frozen individually, but there's no single
 * entity to track for Follow The Player).
 *
 * canFreeze/canFollow (Camera System Expansion) tell the options menu
 * whether those two toggles are meaningful for this focus mode, so it can
 * grey them out instead of offering a control that would silently do
 * nothing: replay actors can't be frozen via input permissions (they're
 * not real players - the replay itself drives their position every tick,
 * and freezing was never about them), and "center" mode has no single
 * live entity for Follow to track (it's a virtual midpoint between two
 * players, not an entity of its own).
 */
function resolveFocus(player, focusMode, focusTargetId) {
    if (focusMode === "self") {
        return { snapshot: snapshotSubject(player), liveEntity: player, canFreeze: true, canFollow: true, defaultFreeze: true, label: player.name };
    }

    if (focusMode === "replay_actor") {
        const active = getActiveActors().find((a) => a.playerId === focusTargetId);
        if (!active) return undefined;
        const record = getReplay(getPlayingReplayId());
        const meta = record ? record.actors.find((a) => a.playerId === focusTargetId) : undefined;
        return {
            snapshot: snapshotSubject(active.entity),
            liveEntity: active.entity,
            canFreeze: false,
            canFollow: true,
            defaultFreeze: false,
            label: meta ? meta.displayName : "Replay Actor"
        };
    }

    const target = findAutoTarget(player);

    if (focusMode === "front") {
        if (!target) return undefined;
        return { snapshot: snapshotSubject(target), liveEntity: target, canFreeze: true, canFollow: true, defaultFreeze: true, label: target.name };
    }

    // center - virtual midpoint, no single entity to freeze input on or follow
    if (!target) return undefined;
    return {
        snapshot: midpointSubject(player, target),
        liveEntity: undefined,
        canFreeze: false,
        canFollow: false,
        defaultFreeze: false,
        label: `you + ${target.name}`
    };
}

/**
 * @param {import("@minecraft/server").Player} player
 * @param {import("../presets/index.js").PRESETS[number]} preset
 * @param {string} focusMode - "front" | "center" | "self" | "replay_actor"
 * @param {string} [focusTargetId] - required when focusMode is "replay_actor"
 */
async function openPresetOptionsMenu(player, preset, focusMode, focusTargetId, savedOptions) {
    const defaults = preset.defaultOptions;
    const remembered = savedOptions || {};
    const favorite = isFavorite(player.id, preset.id);

    const focus = resolveFocus(player, focusMode, focusTargetId);
    if (!focus) {
        player.sendMessage("§cCouldn't find a subject to film - it may have gone offline or the replay may have stopped.");
        return openPresetsMenu(player);
    }

    const form = new ModalFormData()
        .title(`§6${preset.name}`)
        .dropdown("Distance", DISTANCE_LABELS, { defaultValueIndex: DISTANCE_LABELS.indexOf(remembered.distance ?? defaults.distance) })
        .dropdown("Height", HEIGHT_LABELS, { defaultValueIndex: HEIGHT_LABELS.indexOf(remembered.height ?? defaults.height) })
        .dropdown("Duration - higher = slower camera", TICK_LABELS, { defaultValueIndex: closestTickIndex(remembered.durationTicks ?? defaults.durationTicks) })
        .toggle("Countdown (3-2-1-GO)", { defaultValue: remembered.countdown ?? isCountdownEnabled() });

    if (focus.canFreeze) {
        form.toggle("Player Stuck (freeze subject during shot)", { defaultValue: remembered.playerStuck ?? focus.defaultFreeze });
    } else {
        form.toggle("Player Stuck (not available for this subject)", { defaultValue: false });
    }

    if (focus.canFollow) {
        form.toggle("Follow The Player (camera tracks subject's movement)", { defaultValue: remembered.follow ?? false });
    } else {
        form.toggle("Follow The Player (not available for this subject)", { defaultValue: false });
    }

    form.toggle(`★ Favorite ${favorite ? "(currently ON)" : ""}`, { defaultValue: favorite });

    premiumSection(form, "CINEMATIC PRESETS", "Preset Settings");
    const response = await form.show(player);
    if (response.canceled) return;

    const [
        distanceIndex,
        heightIndex,
        tickIndex,
        countdown,
        playerStuckRaw,
        followRaw,
        favoriteRaw
    ] = response.formValues;

    const playerStuck = focus.canFreeze && !!playerStuckRaw;
    const follow = focus.canFollow && !!followRaw;
    const opts = {
        distance: DISTANCE_LABELS[distanceIndex],
        height: HEIGHT_LABELS[heightIndex],
        durationTicks: TICK_OPTIONS[tickIndex]
    };

    const lastRecord = {
        presetId: preset.id,
        presetName: preset.name,
        focusMode,
        focusTargetId,
        options: {
            distance: opts.distance,
            height: opts.height,
            durationTicks: opts.durationTicks,
            countdown: !!countdown,
            playerStuck,
            follow
        }
    };
    setLastPreset(player.id, lastRecord);

    if (favoriteRaw !== favorite) {
        const nowFavorite = toggleFavorite(player.id, preset.id);
        player.sendMessage(nowFavorite
            ? `§a★ ${preset.name} added to Favorites.`
            : `§7★ ${preset.name} removed from Favorites.`);
    }

    let shotFn = preset.generate(focus.snapshot, opts, player.dimension, player);
    if (follow && focus.liveEntity) {
        shotFn = wrapWithFollow(shotFn, focus.snapshot, () => focus.liveEntity);
    }

    player.sendMessage(`§a▶ Running §b${preset.name}§a on §5${focus.label}§a...`);

    await playShot(player, {
        durationTicks: TICK_OPTIONS[tickIndex],
        easing: defaults.easing,
        countdown: !!countdown,
        freezeSubject: playerStuck,
        subject: focus.liveEntity,
        shotFn,
        disableCollision: !!preset.disableCollision,
        sway: preset.sway,
        onComplete: () => {
            if (player.isValid) {
                player.sendMessage("§a✔ Cinematic finished.");
            }
        }
    });
}
