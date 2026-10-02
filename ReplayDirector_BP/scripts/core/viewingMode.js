/**
 * Replay Director - Replay Viewing Mode
 *
 * Wraps a playback session for the director who started it: saves their
 * inventory/armor/offhand/gamemode, clears their inventory, switches them
 * to Creative, and hands them the 7 Director Sticks in fixed hotbar
 * slots (0-6) for fast, menu-free access during filming. On stop, every
 * bit of that is restored exactly and the sticks are removed.
 *
 * This is deliberately a standalone module, not folded into playback.js's
 * own state - it only ever touches the director's own inventory/gamemode,
 * never playback's actor/event/world-replay state, so keeping it separate
 * means a mistake here can't corrupt the replay engine itself.
 *
 * Gamemode note: this switches the director to Creative specifically (per
 * explicit requirement), not Spectator. Bedrock has no per-entity movement-behavior override
 * or script-level way to clear/redirect an already-spawned vanilla mob's
 * target selection - that's a Java-only NBT feature with no Bedrock
 * equivalent - and unlike Spectator, Creative mode has no vanilla rule
 * making the director unnoticed by mobs, so a recorded hostile mob CAN
 * still target the director while they're in Creative here. There is no
 * confirmed Bedrock mechanism that suppresses mob targeting for a player
 * in Creative specifically, so this file does not claim or attempt to
 * prevent that - Creative's own damage immunity (mobs can't actually hurt
 * a Creative player) is the only real mitigation in effect.
 *
 * Deployment note: Player.setGameMode() is a script call, not the /gamemode
 * command, so it does not depend on the world's "Allow Cheats" setting the
 * way manually typing /gamemode would - it's a normal Script API method
 * available to this add-on regardless of that world setting.
 */

import { GameMode } from "@minecraft/server";
import { STICK_NAMES, createDirectorToolStick } from "./directorSticks.js";

const STICK_SLOTS = [
    { slot: 0, name: STICK_NAMES.pause },
    { slot: 1, name: STICK_NAMES.speed },
    { slot: 2, name: STICK_NAMES.presets },
    { slot: 3, name: STICK_NAMES.keyframe },
    { slot: 4, name: STICK_NAMES.timeline },
    { slot: 5, name: STICK_NAMES.gamemode },
    { slot: 6, name: STICK_NAMES.stop },
    { slot: 7, name: STICK_NAMES.skinCycle }
];

const ARMOR_SLOTS = ["Head", "Chest", "Legs", "Feet", "Offhand"];

/** @type {Map<string, {gameMode: import("@minecraft/server").GameMode, inventorySlots: Array<import("@minecraft/server").ItemStack|undefined>, armor: Record<string, import("@minecraft/server").ItemStack|undefined>, selectedSlotIndex: number}>} directorId -> saved state, only present while that director is in viewing mode */
const savedState = new Map();

/**
 * @param {string} directorId
 * @returns {boolean} whether this director currently has a saved viewing-mode state (i.e. is mid-playback)
 */
export function isInViewingMode(directorId) {
    return savedState.has(directorId);
}

/**
 * Snapshots inventory/armor/gamemode, clears the inventory, switches to
 * Creative, and gives the 7 Director Sticks. Safe to call even if this
 * director is somehow already saved (won't double-save over a real
 * snapshot) - callers should still guard against starting playback twice,
 * this is just a last-resort safety net matching this file's fail-soft style.
 * @param {import("@minecraft/server").Player} director
 */
export function enterViewingMode(director) {
    if (!director || !director.isValid || savedState.has(director.id)) return;

    try {
        const inventoryComponent = director.getComponent("minecraft:inventory");
        const container = inventoryComponent ? inventoryComponent.container : undefined;
        const equippable = director.getComponent("minecraft:equippable");

        const inventorySlots = [];
        if (container) {
            for (let i = 0; i < container.size; i++) {
                const item = container.getItem(i);
                inventorySlots.push(item ? item.clone() : undefined);
            }
        }

        const armor = {};
        if (equippable) {
            for (const slotName of ARMOR_SLOTS) {
                try {
                    const item = equippable.getEquipment(slotName);
                    armor[slotName] = item ? item.clone() : undefined;
                } catch (e) {
                    // fail soft - a slot that can't be read is treated as empty on restore
                    armor[slotName] = undefined;
                }
            }
        }

        savedState.set(director.id, {
            gameMode: director.getGameMode(),
            inventorySlots,
            armor,
            selectedSlotIndex: director.selectedSlotIndex
        });

        if (container) {
            container.clearAll();
        }
        if (equippable) {
            for (const slotName of ARMOR_SLOTS) {
                try {
                    equippable.setEquipment(slotName, undefined);
                } catch (e) {
                    // fail soft
                }
            }
        }

        giveDirectorSticks(director, container);

        director.setGameMode(GameMode.Creative);
    } catch (e) {
        // If anything above failed partway through, don't leave a saved
        // state around that restoreViewingMode would apply later against
        // a director who never actually got cleared - that would silently
        // wipe an inventory that was never backed up. Roll the save back.
        savedState.delete(director.id);
    }
}

/**
 * Restores exactly what enterViewingMode saved for this director, and
 * removes the sticks. Safe to call even if this director has no saved
 * state (nothing to do) or has gone offline in the meantime (fails soft -
 * there's nothing to restore an inventory onto if the player object is
 * gone, same as every other cleanup path in this addon).
 * @param {import("@minecraft/server").Player} director
 */
export function exitViewingMode(director) {
    if (!director) return;
    const saved = savedState.get(director.id);
    if (!saved) return;
    if (!director.isValid) {
        // Preserve the snapshot across a normal disconnect. main.js will call
        // restoreViewingModeOnRejoin() with the new valid Player object.
        return;
    }
    savedState.delete(director.id);

    try {
        removeDirectorSticks(director);

        const inventoryComponent = director.getComponent("minecraft:inventory");
        const container = inventoryComponent ? inventoryComponent.container : undefined;
        if (container) {
            container.clearAll();
            for (let i = 0; i < saved.inventorySlots.length && i < container.size; i++) {
                const item = saved.inventorySlots[i];
                if (item) container.setItem(i, item);
            }
        }

        const equippable = director.getComponent("minecraft:equippable");
        if (equippable) {
            for (const slotName of ARMOR_SLOTS) {
                try {
                    equippable.setEquipment(slotName, saved.armor[slotName]);
                } catch (e) {
                    // fail soft
                }
            }
        }

        director.setGameMode(saved.gameMode);
        director.selectedSlotIndex = saved.selectedSlotIndex;
    } catch (e) {
        // fail soft - the director keeps whatever partial restore succeeded
        // rather than the addon throwing mid-cleanup
    }
}

/**
 * Called by the Gamemode stick to let the director switch to a different
 * gamemode mid-playback (e.g. Survival, to test something, or back to
 * Creative) without losing their saved original state - stopping
 * the replay later still restores whatever gamemode they had BEFORE
 * playback started, not whichever one they picked mid-session.
 * @param {import("@minecraft/server").Player} director
 * @param {import("@minecraft/server").GameMode} gameMode
 * @returns {boolean} whether the switch was applied (false if this director isn't in viewing mode)
 */
/**
 * Restores a director's saved pre-playback inventory/armor/gamemode after a
 * normal disconnect/rejoin. The saved snapshot is intentionally kept in
 * memory while the Player object is invalid, then consumed once a valid
 * Player object for the same id exists again.
 * @param {import("@minecraft/server").Player} director
 * @returns {boolean}
 */
export function restoreViewingModeOnRejoin(director) {
    if (!director || !director.isValid) return false;
    if (!savedState.has(director.id)) return false;
    exitViewingMode(director);
    return !savedState.has(director.id);
}

export function setViewingGameMode(director, gameMode) {
    if (!director || !director.isValid || !savedState.has(director.id)) return false;
    try {
        director.setGameMode(gameMode);
        return true;
    } catch (e) {
        return false;
    }
}

function giveDirectorSticks(director, container) {
    if (!container) return;
    for (const { slot, name } of STICK_SLOTS) {
        try {
            container.setItem(slot, createDirectorToolStick(name));
        } catch (e) {
            // fail soft - a slot that can't be set is skipped, rather than
            // aborting the rest of the sticks
        }
    }
}

function removeDirectorSticks(director) {
    try {
        const inventoryComponent = director.getComponent("minecraft:inventory");
        const container = inventoryComponent ? inventoryComponent.container : undefined;
        if (!container) return;
        const stickNames = new Set(STICK_SLOTS.map((s) => s.name));
        for (let i = 0; i < container.size; i++) {
            const item = container.getItem(i);
            if (item && item.typeId === "minecraft:stick" && stickNames.has(item.nameTag)) {
                container.setItem(i, undefined);
            }
        }
    } catch (e) {
        // fail soft
    }
}
