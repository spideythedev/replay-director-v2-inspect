/**
 * Replay Director - Preset Preferences
 *
 * Favorites are stored through the existing preset preference system.
 * Last Preset mirrors the original Replay Director behavior: it remembers
 * the most recently used preset and its settings for the current session.
 */

import { world } from "@minecraft/server";

const LIBRARY_KEY = "replay:preset_library";
const MAX_FAVORITES = 16;

// Last Preset is intentionally session-scoped, matching the original feature.
const lastPresetByPlayer = new Map();

function readLibrary() {
    const raw = world.getDynamicProperty(LIBRARY_KEY);
    if (typeof raw !== "string" || !raw) return {};
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
        return {};
    }
}

function writeLibrary(library) {
    const encoded = JSON.stringify(library);
    if (encoded.length > 30000) return false;
    world.setDynamicProperty(LIBRARY_KEY, encoded);
    return true;
}

function getPlayerLibrary(playerId) {
    const library = readLibrary();
    const entry = library[playerId] ?? { favorites: [] };
    entry.favorites = Array.isArray(entry.favorites) ? entry.favorites : [];
    return { library, entry };
}

export function getFavoriteIds(playerId) {
    return getPlayerLibrary(playerId).entry.favorites.slice();
}

export function isFavorite(playerId, presetId) {
    return getFavoriteIds(playerId).includes(presetId);
}

export function toggleFavorite(playerId, presetId) {
    const { library, entry } = getPlayerLibrary(playerId);
    const index = entry.favorites.indexOf(presetId);

    if (index >= 0) {
        entry.favorites.splice(index, 1);
        library[playerId] = entry;
        writeLibrary(library);
        return false;
    }

    entry.favorites.unshift(presetId);
    entry.favorites = entry.favorites.slice(0, MAX_FAVORITES);
    library[playerId] = entry;
    writeLibrary(library);
    return true;
}

export function getLastPreset(playerId) {
    return lastPresetByPlayer.get(playerId);
}

export function setLastPreset(playerId, record) {
    if (!record || typeof record !== "object" || !record.presetId || !record.options) {
        return false;
    }

    lastPresetByPlayer.set(playerId, {
        presetId: String(record.presetId),
        presetName: String(record.presetName ?? record.presetId),
        focusMode: record.focusMode,
        focusTargetId: record.focusTargetId,
        options: {
            distance: record.options.distance,
            height: record.options.height,
            durationTicks: Number(record.options.durationTicks),
            countdown: !!record.options.countdown,
            playerStuck: !!record.options.playerStuck,
            follow: !!record.options.follow
        }
    });
    return true;
}

export function clearLastPreset(playerId) {
    lastPresetByPlayer.delete(playerId);
    return true;
}
