/**
 * Replay Director - Manual Camera Mode Sticks
 *
 * Gives the director 9 dedicated items for Manual Camera Mode (Add
 * Keyframe, Manage Keyframes, Play Camera Animation, Clear Path, Exit,
 * Undo, Redo, Curve Here, Curve Mode) instead of requiring the menu to stay open, mirroring the
 * existing 7-stick Director Sticks system for Replay Playback
 * (core/viewingMode.js) - but this is a COMPLETELY SEPARATE module with
 * its own saved-state map, its own stick names, and its own enter/exit
 * functions. It does not import from, call, or share any state with
 * viewingMode.js, and viewingMode.js is not modified by this file at
 * all - Replay Playback's own 7 sticks, inventory snapshot/restore, and
 * gamemode switching behave exactly as they did before this feature
 * existed, regardless of whether Manual Camera Mode is active.
 *
 * Design choice, per explicit confirmation: entering Manual Camera Mode
 * happens ONCE (guarded by savedState.has(), same guard pattern as
 * viewingMode.js) even though openManualCameraMenu() itself is called
 * repeatedly (it's a recursive menu that redraws itself after every
 * action) - without that guard, every redraw would re-snapshot the
 * inventory and overwrite the real original with an already-cleared
 * state, which would be a genuine data-loss bug. Restoring likewise only
 * happens on the explicit Exit stick - Play Camera Animation/Preview
 * Path keep the player in stick mode through the cinematic (per
 * explicit confirmation), they do not restore inventory mid-shot.
 *
 * Unlike viewingMode.js, this does NOT change gamemode. When entered during
 * Replay Playback, it temporarily swaps the existing Replay Director
 * playback sticks for the Manual Camera controls, then restores those exact
 * playback sticks on exit. This lets Manual Camera behave identically
 * whether a replay is running or not, without destroying the playback
 * viewing-mode snapshot.
 */

import { ItemStack } from "@minecraft/server";

/** nameTag of each Manual Camera Mode stick - deliberately its own namespace/wording (not reusing STICK_NAMES from core/directorSticks.js) so there is zero chance of an item-use event ever matching both this file's handler AND main.js's Replay Playback STICK_HANDLERS map for the same item. */
export const MANUAL_STICK_NAMES = {
    addKeyframe: "§a§lAdd Keyframe (Manual Camera)",
    manageKeyframes: "§b§lManage Keyframes",
    playAnimation: "§5§lPlay Camera Animation",
    clearPath: "§c§lClear Path",
    exit: "§7§lExit Manual Camera Mode",
    undo: "§6§l↺ Undo (Manual Camera)",
    redo: "§6§l↻ Redo (Manual Camera)",
    curveHere: "§f§l＋ Curve Here (Manual Camera)",
    curveToggle: "§e§l◉ Curve Mode (Manual Camera)"
};

const STICK_SLOTS = [
    { slot: 0, name: MANUAL_STICK_NAMES.addKeyframe },
    { slot: 1, name: MANUAL_STICK_NAMES.manageKeyframes },
    { slot: 2, name: MANUAL_STICK_NAMES.playAnimation },
    { slot: 3, name: MANUAL_STICK_NAMES.clearPath },
    { slot: 4, name: MANUAL_STICK_NAMES.exit },
    { slot: 5, name: MANUAL_STICK_NAMES.undo },
    { slot: 6, name: MANUAL_STICK_NAMES.redo },
    { slot: 7, name: MANUAL_STICK_NAMES.curveHere },
    { slot: 8, name: MANUAL_STICK_NAMES.curveToggle }
];

/** @type {Map<string, {inventorySlots: Array<import("@minecraft/server").ItemStack|undefined>, selectedSlotIndex: number}>} playerId -> saved inventory, only present while that player is in Manual Camera stick mode. Armor/offhand and gamemode are deliberately NOT touched/saved here (see file header) - only the hotbar/inventory container, which is all the existing Manual Camera Mode menu flow ever needed either. */
const savedState = new Map();

/** @param {string} playerId */
export function isInManualStickMode(playerId) {
    return savedState.has(playerId);
}

/**
 * Snapshots the player's inventory, clears it, and gives the 9 Manual
 * Camera sticks. No-ops if this player is already in Manual Camera
 * stick mode (see file header - this is what makes it safe to call on
 * every openManualCameraMenu() redraw without re-snapshotting over the
 * real original).
 * @param {import("@minecraft/server").Player} player
 * @param {{replayActive?: boolean}} [options]
 */
export function enterManualStickMode(player, options = {}) {
    if (!player || !player.isValid || savedState.has(player.id)) return;

    try {
        const inventoryComponent = player.getComponent("minecraft:inventory");
        const container = inventoryComponent ? inventoryComponent.container : undefined;
        if (!container) return;

        const inventorySlots = [];
        for (let i = 0; i < container.size; i++) {
            const item = container.getItem(i);
            inventorySlots.push(item ? item.clone() : undefined);
        }

        savedState.set(player.id, {
            inventorySlots,
            selectedSlotIndex: player.selectedSlotIndex,
            replayActive: options.replayActive === true
        });

        container.clearAll();
        const given = giveManualSticks(container);
        if (given === STICK_SLOTS.length) {
            // Put the first Manual Camera control in the active slot so the
            // mode visibly enters with a usable control selected, regardless
            // of which hotbar slot the player was using before entry.
            player.selectedSlotIndex = 0;
        }
        if (given !== STICK_SLOTS.length) {
            // Roll back the saved state rather than leaving a partially
            // populated Manual Camera hotbar that looks like a broken mode.
            container.clearAll();
            for (let i = 0; i < inventorySlots.length && i < container.size; i++) {
                const item = inventorySlots[i];
                if (item) container.setItem(i, item);
            }
            player.selectedSlotIndex = Math.min(
                savedState.get(player.id)?.selectedSlotIndex ?? 0,
                Math.max(0, container.size - 1)
            );
            savedState.delete(player.id);
            player.sendMessage("§cManual Camera controls could not be loaded completely. Your inventory was restored.");
        }
    } catch (e) {
        // If anything above failed partway through, don't leave a saved
        // state around that exitManualStickMode would apply later
        // against a player who never actually got cleared - that would
        // silently wipe an inventory that was never backed up. Roll the
        // save back, same fail-soft rollback viewingMode.js uses.
        savedState.delete(player.id);
    }
}

/**
 * Removes the Manual Camera sticks and restores exactly what
 * enterManualStickMode saved - either the player's normal inventory
 * (standalone mode) or the Replay Playback sticks that were temporarily
 * replaced (replay Manual Camera mode). Safe to call even if this player has no saved state
 * (nothing to do) or has gone offline since (fails soft, nothing to
 * restore an inventory onto).
 * @param {import("@minecraft/server").Player} player
 */
export function exitManualStickMode(player) {
    if (!player) return;
    const saved = savedState.get(player.id);
    if (!saved) return;
    savedState.delete(player.id);

    if (!player.isValid) return;

    try {
        const inventoryComponent = player.getComponent("minecraft:inventory");
        const container = inventoryComponent ? inventoryComponent.container : undefined;
        if (!container) return;

        container.clearAll();
        for (let i = 0; i < saved.inventorySlots.length && i < container.size; i++) {
            const item = saved.inventorySlots[i];
            if (item) container.setItem(i, item);
        }
        player.selectedSlotIndex = saved.selectedSlotIndex;
    } catch (e) {
        // fail soft - the player keeps whatever partial restore
        // succeeded rather than the addon throwing mid-cleanup
    }
}

function giveManualSticks(container) {
    let count = 0;
    for (const { slot, name } of STICK_SLOTS) {
        try {
            const stack = new ItemStack("minecraft:stick", 1);
            stack.nameTag = name;
            // A named stick can still behave like a normal stackable item on
            // some Bedrock builds. Give each control its own tiny lore
            // payload so the nine controls remain nine distinct hotbar
            // stacks instead of collapsing into one visible stick.
            stack.setLore([`§8Replay Director • Manual Camera • Slot ${slot + 1}`]);
            container.setItem(slot, stack);
            const placed = container.getItem(slot);
            if (placed && placed.typeId === "minecraft:stick" && placed.nameTag === name) {
                count++;
            }
        } catch (e) {
            // fail soft - a slot that can't be set is counted as missing so
            // enterManualStickMode can roll the whole inventory back safely.
        }
    }
    return count;
}

/**
 * Returns the exact Manual Camera stick set currently present in the
 * director's hotbar. This is intentionally based on the existing stick
 * identities rather than inventing a second control registry.
 * @param {import("@minecraft/server").Player} player
 */
export function getManualStickStatus(player) {
    const result = {
        loaded: 0,
        total: STICK_SLOTS.length,
        names: []
    };
    if (!player || !player.isValid) return result;

    try {
        const inventoryComponent = player.getComponent("minecraft:inventory");
        const container = inventoryComponent ? inventoryComponent.container : undefined;
        if (!container) return result;

        for (const { slot, name } of STICK_SLOTS) {
            const item = container.getItem(slot);
            if (item && item.typeId === "minecraft:stick" && item.nameTag === name) {
                result.loaded++;
                result.names.push(name);
            }
        }
    } catch (e) {
        // fail soft
    }
    return result;
}
