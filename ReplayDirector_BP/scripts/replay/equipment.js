/**
 * Replay Director - Equipment Renderer (visuals only)
 *
 * Replaces the earlier EntityEquippableComponent.setEquipment() approach.
 * Confirmed in-game (manual chat commands, then confirmed again via
 * entity.runCommand from script) that /replaceitem entity @s slot.<slot> 0
 * <item> 1 renders correctly on replay:actor for weapon.mainhand,
 * weapon.offhand, and armor.head - both as a typed command and via the
 * Script API. getComponent("minecraft:equippable") itself was the broken
 * link: a control probe spawning a vanilla minecraft:wolf (a mob Mojang's
 * own wolf.json declares should have this component) returned the same
 * undefined result, meaning the failure was in how the component accessor
 * behaves here, not something specific to replay:actor. The equipment
 * container and its rendering were never actually broken.
 *
 * This module is deliberately scoped to visuals only - it knows nothing
 * about recording, timeline, playback speed, or camera, and doesn't touch
 * any of that code. It exposes the same setActorEquipment /
 * clearActorEquipment / applyActorEquipment shape the manual UI and
 * automatic recording both need, so either caller can drive it identically.
 *
 * No custom geometry, texture sheets, or entity properties are used for
 * rendering here - real vanilla item identifiers only (e.g.
 * minecraft:diamond_helmet), applied straight to the vanilla equipment
 * slots via /replaceitem.
 */

import { rdLog, rdWarn, rdError } from "../core/debugLog.js";

/** Our own snapshot/UI field names, mapped to the /replaceitem slot names for that slot. */
const REPLACEITEM_SLOT_MAP = {
    head: "slot.armor.head",
    chest: "slot.armor.chest",
    legs: "slot.armor.legs",
    feet: "slot.armor.feet",
    mainhand: "slot.weapon.mainhand",
    offhand: "slot.weapon.offhand"
};

const EMPTY_ITEM = "air";

/**
 * Applies (or clears) a single equipment slot on the exact live actor
 * entity via /replaceitem. The command is executed as that Entity with @s,
 * so there is no tag-selector race between the script-held entity reference
 * and the command target.
 * @param {import("@minecraft/server").Entity} entity
 * @param {"head"|"chest"|"legs"|"feet"|"mainhand"|"offhand"} slot
 * @param {string|undefined} itemId - real vanilla item identifier (e.g. "minecraft:diamond_helmet"), or undefined/falsy to clear the slot
 * @param {number} [amount=1]
 * @returns {boolean} true if the command ran without throwing and successCount > 0
 */
export function setActorEquipment(entity, slot, itemId, amount = 1) {
    if (!entity || !entity.isValid) {
        rdWarn(`setActorEquipment: entity missing/invalid - aborting (slot="${slot}").`);
        return false;
    }

    const replaceitemSlot = REPLACEITEM_SLOT_MAP[slot];
    if (!replaceitemSlot) {
        rdError(`setActorEquipment: unknown slot key "${slot}" - not in REPLACEITEM_SLOT_MAP.`);
        return false;
    }

    const targetItem = itemId || EMPTY_ITEM;
    const clampedAmount = Math.max(1, Math.min(64, (itemId ? amount : 1) || 1));

    // Execute as the exact actor reference using @s. The previous
    // implementation discovered an ashN tag and then ran the command from
    // the dimension with @e[tag=ashN]. During deferred playback that selector
    // can resolve to zero entities even while this Entity reference is valid,
    // producing successCount=0 and equipment errors. @s removes that selector
    // race completely.
    const command = `replaceitem entity @s ${replaceitemSlot} 0 ${targetItem} ${clampedAmount}`;

    try {
        const result = entity.runCommand(command);
        const successCount = result && typeof result.successCount === "number"
            ? result.successCount
            : undefined;

        if (successCount === 0) {
            rdWarn(`setActorEquipment: "${command}" returned successCount=0 on entity id=${entity.id}.`);
            return false;
        }

        rdLog(`setActorEquipment: entity id=${entity.id} slot="${slot}" -> "${targetItem}" successCount=${successCount ?? "unknown"}.`);
        return true;
    } catch (e) {
        rdError(`setActorEquipment: "${command}" THREW on entity id=${entity.id}.`, e);
        return false;
    }
}

/** Clears every equipment slot on an actor - used on spawn (before any manual/recorded equipment is applied) and when seeking to a point before any equipment was recorded. */
export function clearActorEquipment(entity) {
    if (!entity || !entity.isValid) {
        rdWarn(`clearActorEquipment: entity missing/invalid - aborting.`);
        return;
    }
    for (const slot of Object.keys(REPLACEITEM_SLOT_MAP)) {
        setActorEquipment(entity, slot, undefined);
    }
    rdLog(`clearActorEquipment: cleared all slots on entity id=${entity.id}.`);
}

/**
 * Applies a full equipment map/snapshot ({head, chest, legs, feet,
 * mainhand, offhand}, each an item snapshot object with a typeId, or
 * undefined/missing for an empty slot) to an actor in one call. Used by
 * both the manual per-actor UI (a fixed equipment map) and playback
 * (a per-tick recorded snapshot) - same shape either way.
 * @param {import("@minecraft/server").Entity} entity
 * @param {object|undefined} equipmentMap - keys are head/chest/legs/feet/mainhand/offhand, each either {typeId, amount} or undefined/missing
 * @returns {object|undefined} the map that was applied (echoed back for callers that want to remember "last applied"), or undefined if nothing was applied
 */
export function applyActorEquipment(entity, equipmentMap) {
    if (!entity || !entity.isValid) {
        rdWarn(`applyActorEquipment: entity missing/invalid - aborting.`);
        return undefined;
    }
    if (!equipmentMap) {
        rdLog(`applyActorEquipment: no equipment map given - nothing to apply, entity id=${entity.id}.`);
        return undefined;
    }

    for (const slot of Object.keys(REPLACEITEM_SLOT_MAP)) {
        const snapshot = equipmentMap[slot];
        const itemId = snapshot && snapshot.typeId ? snapshot.typeId : undefined;
        const amount = snapshot && snapshot.amount ? snapshot.amount : 1;
        setActorEquipment(entity, slot, itemId, amount);
    }

    return equipmentMap;
}

/** True if two item snapshots (either may be undefined, meaning "empty slot") describe the same item, for the purposes of visual equipment - only typeId/amount matter here since /replaceitem doesn't round-trip durability/enchantments/nameTag anyway. */
function itemSnapshotsEqual(a, b) {
    if (a === b) return true;
    if (!a || !b) return false;
    return a.typeId === b.typeId && (a.amount || 1) === (b.amount || 1);
}

/** True if every slot in two equipment maps matches - used to skip re-applying equipment that hasn't actually changed since the last call (e.g. during per-tick playback). */
export function equipmentMapsEqual(a, b) {
    if (a === b) return true;
    if (!a || !b) return false;
    for (const slot of Object.keys(REPLACEITEM_SLOT_MAP)) {
        if (!itemSnapshotsEqual(a[slot], b[slot])) return false;
    }
    return true;
}

export const EQUIPMENT_SLOT_KEYS = Object.keys(REPLACEITEM_SLOT_MAP);
