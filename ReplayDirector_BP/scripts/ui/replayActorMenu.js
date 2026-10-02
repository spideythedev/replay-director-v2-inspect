import { premiumSection, premiumActive, premiumDisabled, premiumPrimary, premiumSecondary, premiumDanger, premiumBack, premiumLabel, premiumBody } from "./theme.js";
/**
 * Replay Director - Replay Actor (Phase 3B, Armor/Held Item wired in the
 * Equipment Renderer pass)
 *
 * Per-actor settings for one recorded player within one saved replay.
 * Skin, Armor, and Held Item are all live now - each is scoped to this
 * replay's actor only, and won't affect any other replay unless changed
 * there too. Armor/Held Item set here is a manual per-actor override
 * (actor.armor), applied by spawnActor() every time playback spawns this
 * actor, and independent of anything actually recorded for this actor
 * (recorded equipment, when present, plays back over top of this via
 * updateActorEquipment() - see actors.js). This now offers full real
 * vanilla item tiers (Wooden through Netherite) since rendering goes
 * through /replaceitem with real item identifiers - no enum-cap or
 * custom-art constraint. Name & Nametag (rename, color, show/hide) and
 * Visibility (per-actor Visible/Invisible, independent for every actor)
 * are both live now.
 */

import { ActionFormData, ModalFormData } from "@minecraft/server-ui";
import { getReplay, updateActor } from "../replay/storage.js";
import { REPLAY_SKINS, getSkinById } from "../core/replaySkins.js";
import { openReplayEditorMenu } from "./replayEditorMenu.js";
import { getPlayingReplayId, getActiveActors } from "../replay/playback.js";
import { setActorEquipment } from "../replay/equipment.js";
import { rdLog, rdWarn } from "../core/debugLog.js";

/**
 * If this exact replay is currently playing AND this actor has a live
 * spawned entity right now, push the change immediately via
 * setActorEquipment() so it's visible without waiting for the next spawn.
 * This menu previously only wrote to storage (updateActor) - correct for
 * "next time this replay plays," but a no-op if the replay is already
 * mid-playback, which is the exact case being tested via the Director
 * Stick's Armor option. Data-only save behavior (storage write) is
 * untouched; this only adds a live push on top when applicable.
 * @param {string} replayId
 * @param {string} actorPlayerId
 * @param {"head"|"chest"|"legs"|"feet"|"mainhand"|"offhand"} slotKey
 * @param {string|undefined} itemId
 */
function liveApplyIfPlaying(replayId, actorPlayerId, slotKey, itemId) {
    const playingReplayId = getPlayingReplayId();
    if (!playingReplayId || playingReplayId !== replayId) {
        rdLog(`liveApplyIfPlaying: replay ${replayId} not currently playing (playing=${playingReplayId || "none"}) - storage-only, will apply on next spawn.`);
        return;
    }
    const activeActors = getActiveActors();
    const match = activeActors ? activeActors.find((a) => a.playerId === actorPlayerId) : undefined;
    const entity = match ? match.entity : undefined;
    if (!entity || !entity.isValid) {
        rdLog(`liveApplyIfPlaying: replay ${replayId} is playing but no live entity found for actor ${actorPlayerId} - storage-only.`);
        return;
    }
    rdLog(`liveApplyIfPlaying: replay ${replayId} is live - pushing slot="${slotKey}" itemId="${itemId || "clear"}" to entity id=${entity.id} now.`);
    setActorEquipment(entity, slotKey, itemId, 1);
}

/**
 * Same live-apply idea as liveApplyIfPlaying above, but for the nametag
 * itself - nameTag isn't equipment so it's set directly on the entity
 * rather than through setActorEquipment(). Takes the already-updated
 * actor record (post-updateActor) so it composes color+text+visibility
 * exactly the way spawnActor() does, instead of duplicating that logic
 * with slightly different inputs.
 * @param {string} replayId
 * @param {string} actorPlayerId
 * @param {object} actorRecord - the actor record AFTER the change has been written
 */
function liveApplyNameIfPlaying(replayId, actorPlayerId, actorRecord) {
    const playingReplayId = getPlayingReplayId();
    if (!playingReplayId || playingReplayId !== replayId) {
        rdLog(`liveApplyNameIfPlaying: replay ${replayId} not currently playing - storage-only, will apply on next spawn.`);
        return;
    }
    const activeActors = getActiveActors();
    const match = activeActors ? activeActors.find((a) => a.playerId === actorPlayerId) : undefined;
    const entity = match ? match.entity : undefined;
    if (!entity || !entity.isValid) {
        rdLog(`liveApplyNameIfPlaying: replay ${replayId} is playing but no live entity found for actor ${actorPlayerId} - storage-only.`);
        return;
    }
    try {
        const rawName = actorRecord.displayName || actorRecord.playerName || "";
        entity.nameTag = actorRecord.nameTagVisible === false ? "" : `${actorRecord.nameColor || ""}${rawName}`;
        rdLog(`liveApplyNameIfPlaying: replay ${replayId} is live - pushed nametag update to entity id=${entity.id} now.`);
    } catch (e) {
        rdWarn(`liveApplyNameIfPlaying: setting nameTag threw for entity id=${entity.id}.`, e);
    }
}

/**
 * Same live-apply idea as liveApplyIfPlaying/liveApplyNameIfPlaying above,
 * but for the skin - pushes the "replay:skin_index" entity property
 * directly, the same property spawnActor() sets from REPLAY_SKINS, so a
 * skin change is visible immediately instead of only on the next time
 * this replay starts playing.
 * @param {string} replayId
 * @param {string} actorPlayerId
 * @param {string} skinId
 */
function liveApplySkinIfPlaying(replayId, actorPlayerId, skinId) {
    const playingReplayId = getPlayingReplayId();
    if (!playingReplayId || playingReplayId !== replayId) {
        rdLog(`liveApplySkinIfPlaying: replay ${replayId} not currently playing - storage-only, will apply on next spawn.`);
        return;
    }
    const activeActors = getActiveActors();
    const match = activeActors ? activeActors.find((a) => a.playerId === actorPlayerId) : undefined;
    const entity = match ? match.entity : undefined;
    if (!entity || !entity.isValid) {
        rdLog(`liveApplySkinIfPlaying: replay ${replayId} is playing but no live entity found for actor ${actorPlayerId} - storage-only.`);
        return;
    }
    try {
        const skinIndex = REPLAY_SKINS.findIndex((s) => s.id === skinId);
        entity.setProperty("replay:skin_index", skinIndex >= 0 ? skinIndex : 0);
        rdLog(`liveApplySkinIfPlaying: replay ${replayId} is live - pushed skin_index=${skinIndex >= 0 ? skinIndex : 0} to entity id=${entity.id} now.`);
    } catch (e) {
        rdWarn(`liveApplySkinIfPlaying: setting replay:skin_index threw for entity id=${entity.id}.`, e);
    }
}

/**
 * Same live-apply idea as liveApplyIfPlaying/liveApplyNameIfPlaying/
 * liveApplySkinIfPlaying above, but for per-actor visibility - adds or
 * clears the invisibility effect directly on the live entity so toggling
 * Visible/Invisible takes effect immediately during playback, instead of
 * only on the next time this replay starts.
 * @param {string} replayId
 * @param {string} actorPlayerId
 * @param {boolean} hidden
 */
function liveApplyVisibilityIfPlaying(replayId, actorPlayerId, hidden) {
    const playingReplayId = getPlayingReplayId();
    if (!playingReplayId || playingReplayId !== replayId) {
        rdLog(`liveApplyVisibilityIfPlaying: replay ${replayId} not currently playing - storage-only, will apply on next spawn.`);
        return;
    }
    const activeActors = getActiveActors();
    const match = activeActors ? activeActors.find((a) => a.playerId === actorPlayerId) : undefined;
    const entity = match ? match.entity : undefined;
    if (!entity || !entity.isValid) {
        rdLog(`liveApplyVisibilityIfPlaying: replay ${replayId} is playing but no live entity found for actor ${actorPlayerId} - storage-only.`);
        return;
    }
    try {
        if (hidden) {
            entity.addEffect("invisibility", 20000000, { amplifier: 0, showParticles: false });
        } else {
            entity.removeEffect("invisibility");
        }
        rdLog(`liveApplyVisibilityIfPlaying: replay ${replayId} is live - set hidden=${hidden} on entity id=${entity.id} now.`);
    } catch (e) {
        rdWarn(`liveApplyVisibilityIfPlaying: toggling invisibility threw for entity id=${entity.id}.`, e);
    }
}

/** Armor slot key -> display label, item-tier prefix, and armor-piece suffix, for building the vanilla item identifier per tier (e.g. "leather" + "_helmet" -> minecraft:leather_helmet). Turtle shell intentionally left out - not part of the standard armor progression. Elytra IS supported, as a special case added directly in openArmorTierPicker (chest slot only) since it's a standalone item, not a material tier. */
const ARMOR_SLOTS = [
    { key: "head", label: "Helmet", suffix: "_helmet" },
    { key: "chest", label: "Chestplate", suffix: "_chestplate" },
    { key: "legs", label: "Leggings", suffix: "_leggings" },
    { key: "feet", label: "Boots", suffix: "_boots" }
];

/** Armor material tiers, in progression order, for the per-slot tier picker. */
const ARMOR_TIERS = [
    { id: "leather", label: "Leather" },
    { id: "golden", label: "Golden" },
    { id: "chainmail", label: "Chainmail" },
    { id: "iron", label: "Iron" },
    { id: "diamond", label: "Diamond" },
    { id: "netherite", label: "Netherite" }
];

/** Common held-item choices for mainhand/offhand - real vanilla identifiers, a practical shortlist rather than every item in the game. */
const HELD_ITEM_CHOICES = [
    { id: "minecraft:wooden_sword", label: "Wooden Sword" },
    { id: "minecraft:stone_sword", label: "Stone Sword" },
    { id: "minecraft:golden_sword", label: "Golden Sword" },
    { id: "minecraft:iron_sword", label: "Iron Sword" },
    { id: "minecraft:diamond_sword", label: "Diamond Sword" },
    { id: "minecraft:netherite_sword", label: "Netherite Sword" },
    { id: "minecraft:bow", label: "Bow" },
    { id: "minecraft:crossbow", label: "Crossbow" },
    { id: "minecraft:trident", label: "Trident" },
    { id: "minecraft:shield", label: "Shield" },
    { id: "minecraft:totem_of_undying", label: "Totem of Undying" },
    { id: "minecraft:torch", label: "Torch" }
];

/** Name color palette - standard Bedrock "§" color codes, offered as a simple named list rather than making the director memorize codes. "Default" clears the override (nameColor: undefined) so the tag renders in vanilla white. */
const NAME_COLORS = [
    { code: undefined, label: "Default (White)" },
    { code: "§c", label: "Red" },
    { code: "§6", label: "Orange" },
    { code: "§5", label: "Yellow" },
    { code: "§a", label: "Green" },
    { code: "§b", label: "Aqua" },
    { code: "§9", label: "Blue" },
    { code: "§d", label: "Pink" },
    { code: "§5", label: "Purple" },
    { code: "§9", label: "White" },
    { code: "§7", label: "Gray" },
    { code: "§8", label: "Dark Gray" },
    { code: "§3", label: "Black" },
    { code: "§g", label: "Gold (Bedrock-only)" }
];

/**
 * @param {import("@minecraft/server").Player} player
 * @param {string} replayId
 * @param {string} actorPlayerId
 * @param {{standalone?: boolean}} [opts] - standalone=true when reached directly from the Actor Skin Stick rather than by navigating down from Edit Replay. Only affects where the labeled "« Back"/"« Close" button goes - X/Escape always just closes the menu regardless.
 */
export async function openReplayActorMenu(player, replayId, actorPlayerId, opts = {}) {
    const { standalone = false } = opts;

    const record = getReplay(replayId);
    if (!record) {
        player.sendMessage("§cThat replay no longer exists.");
        return openReplayEditorMenu(player, replayId);
    }
    const actor = record.actors.find((a) => a.playerId === actorPlayerId);
    if (!actor) {
        return openReplayEditorMenu(player, replayId);
    }

    const skin = getSkinById(actor.skinId);
    const armorSummary = summarizeArmor(actor.armor);
    const nameSummary = summarizeName(actor);
    const visibilitySummary = actor.hidden ? "Invisible" : "Visible";

    const form = new ActionFormData()
        .title(`§6${actor.displayName}`)
        .body(`§7Recorded as: §9${actor.playerName}\n§r§8Current skin: §9${skin ? skin.name : "none"}\n§r§8Armor override: §9${armorSummary}\n§r§8Nametag: §9${nameSummary}\n§r§8Visibility: §9${visibilitySummary}`)
        .button("§3Skin")
        .button("§3Name & Nametag")
        .button("§3Armor")
        .button("§3Held Item")
        .button(`§3Visibility\n§r§8${visibilitySummary}`)
        .button(standalone ? "§3« Close" : "§7« Back");

    premiumSection(form, "ACTOR STUDIO", "Actor Studio");
    const response = await form.show(player);
    if (response.canceled) return;

    switch (response.selection) {
        case 0:
            return openSkinPicker(player, replayId, actorPlayerId, opts);
        case 1:
            return openNameMenu(player, replayId, actorPlayerId, opts);
        case 2:
            return openArmorMenu(player, replayId, actorPlayerId, opts);
        case 3:
            return openHeldItemMenu(player, replayId, actorPlayerId, opts);
        case 4:
            return openVisibilityMenu(player, replayId, actorPlayerId, opts);
        case 5:
            return standalone ? undefined : openReplayEditorMenu(player, replayId);
    }
}

/** "Renamed §cRed" / "Default" style summary for the actor menu body line. */
function summarizeName(actor) {
    if (actor.nameTagVisible === false) return "hidden";
    const colorDef = NAME_COLORS.find((c) => c.code === actor.nameColor);
    const colorLabel = colorDef ? colorDef.label : "custom";
    return actor.nameColor ? colorLabel : "Default";
}

/** Short "N/4 pieces" style summary for the actor menu body line - avoids listing all four slots inline when most are usually empty. */
function summarizeArmor(armor) {
    if (!armor) return "none";
    const equippedCount = ARMOR_SLOTS.filter((s) => armor[s.key] && armor[s.key].typeId).length;
    if (equippedCount === 0) return "none";
    return `${equippedCount}/${ARMOR_SLOTS.length} pieces`;
}

async function openSkinPicker(player, replayId, actorPlayerId, opts = {}) {
    const record = getReplay(replayId);
    if (!record) return openReplayEditorMenu(player, replayId);
    const actor = record.actors.find((a) => a.playerId === actorPlayerId);

    const form = new ActionFormData().title("§6Skin").body("§7Pick this replay actor's skin - only affects this replay.");
    for (const skin of REPLAY_SKINS) {
        const marker = actor && actor.skinId === skin.id ? "§a✔ " : "§b";
        form.button(`${marker}${skin.name}`);
    }
    form.button("§3« Back");

    premiumSection(form, "ACTOR STUDIO", "Skin");
    const response = await form.show(player);
    if (response.canceled) return;

    if (response.selection === REPLAY_SKINS.length) {
        return openReplayActorMenu(player, replayId, actorPlayerId, opts);
    }

    const chosen = REPLAY_SKINS[response.selection];
    updateActor(replayId, actorPlayerId, { skinId: chosen.id });
    liveApplySkinIfPlaying(replayId, actorPlayerId, chosen.id);
    player.sendMessage(`§a✔ Set skin to §b${chosen.name}§a for this replay actor.`);
    return openReplayActorMenu(player, replayId, actorPlayerId, opts);
}

/**
 * Name & Nametag - groups the three related settings (rename, color,
 * show/hide) under one submenu instead of three separate top-level rows
 * on the actor menu, so the main actor screen stays a clean 5-button list
 * as new features get added rather than growing one row per feature.
 */
async function openNameMenu(player, replayId, actorPlayerId, opts = {}) {
    const record = getReplay(replayId);
    if (!record) return openReplayEditorMenu(player, replayId);
    const actor = record.actors.find((a) => a.playerId === actorPlayerId);
    if (!actor) return openReplayEditorMenu(player, replayId);

    const colorDef = NAME_COLORS.find((c) => c.code === actor.nameColor);
    const colorLabel = colorDef ? colorDef.label : "Custom";
    const visibleLabel = actor.nameTagVisible === false ? "§cHidden" : "§aShowing";

    const form = new ActionFormData()
        .title("§6Name & Nametag")
        .body(`§7Preview: ${actor.nameTagVisible === false ? "§8(hidden)" : `${actor.nameColor || ""}${actor.displayName}`}`)
        .button(`§2Rename\n§r§8Currently: ${actor.displayName}`)
        .button(`§2Color\n§r§8Currently: ${colorLabel}`)
        .button(`§3Toggle Nametag\n§r§8${visibleLabel}`)
        .button("§3« Back");

    premiumSection(form, "ACTOR STUDIO", "Name & Nametag");
    const response = await form.show(player);
    if (response.canceled) return;

    switch (response.selection) {
        case 0:
            return openRenamePrompt(player, replayId, actorPlayerId, opts);
        case 1:
            return openNameColorPicker(player, replayId, actorPlayerId, opts);
        case 2: {
            const nextVisible = actor.nameTagVisible === false; // toggling from hidden -> showing or vice versa
            const updated = { ...actor, nameTagVisible: nextVisible };
            updateActor(replayId, actorPlayerId, { nameTagVisible: nextVisible });
            liveApplyNameIfPlaying(replayId, actorPlayerId, updated);
            player.sendMessage(nextVisible ? "§a✔ Nametag shown." : "§a✔ Nametag hidden.");
            return openNameMenu(player, replayId, actorPlayerId, opts);
        }
        case 3:
            return openReplayActorMenu(player, replayId, actorPlayerId, opts);
    }
}

/** Text-input rename - separate from color, so retyping the name never means re-picking a color too, and vice versa. Empty/whitespace-only input is rejected rather than silently blanking the nametag (use Toggle Nametag for that instead). */
async function openRenamePrompt(player, replayId, actorPlayerId, opts = {}) {
    const record = getReplay(replayId);
    if (!record) return openReplayEditorMenu(player, replayId);
    const actor = record.actors.find((a) => a.playerId === actorPlayerId);
    if (!actor) return openReplayEditorMenu(player, replayId);

    const form = new ModalFormData().title("Rename Actor").textField("Nametag text", actor.playerName, { defaultValue: actor.displayName });
    premiumSection(form, "ACTOR STUDIO", "Rename Actor");
    const response = await form.show(player);
    if (response.canceled) return;

    const [newName] = response.formValues;
    if (newName && newName.trim().length > 0) {
        const trimmed = newName.trim();
        const updated = { ...actor, displayName: trimmed };
        updateActor(replayId, actorPlayerId, { displayName: trimmed });
        liveApplyNameIfPlaying(replayId, actorPlayerId, updated);
        player.sendMessage(`§a✔ Renamed to §9${trimmed}§a for this replay actor.`);
    } else {
        player.sendMessage("§cName can't be empty - kept the previous name.");
    }
    return openNameMenu(player, replayId, actorPlayerId, opts);
}

/** Color picker for the nametag - a named list of standard "§" color codes rather than asking the director to type codes by hand. */
async function openNameColorPicker(player, replayId, actorPlayerId, opts = {}) {
    const record = getReplay(replayId);
    if (!record) return openReplayEditorMenu(player, replayId);
    const actor = record.actors.find((a) => a.playerId === actorPlayerId);
    if (!actor) return openReplayEditorMenu(player, replayId);

    const form = new ActionFormData().title("§6Nametag Color").body(`§7Preview: ${actor.displayName}`);
    for (const colorDef of NAME_COLORS) {
        const marker = actor.nameColor === colorDef.code ? "§a✔ " : "";
        const swatch = colorDef.code || "§9";
        form.button(`${marker}${swatch}${colorDef.label}`);
    }
    form.button("§3« Back");

    premiumSection(form, "ACTOR STUDIO", "Nametag Color");
    const response = await form.show(player);
    if (response.canceled) return;

    if (response.selection === NAME_COLORS.length) {
        return openNameMenu(player, replayId, actorPlayerId, opts);
    }

    const chosen = NAME_COLORS[response.selection];
    const updated = { ...actor, nameColor: chosen.code };
    updateActor(replayId, actorPlayerId, { nameColor: chosen.code });
    liveApplyNameIfPlaying(replayId, actorPlayerId, updated);
    player.sendMessage(`§a✔ Nametag color set to §9${chosen.label}§a for this replay actor.`);
    return openNameMenu(player, replayId, actorPlayerId, opts);
}

/**
 * Visibility - per-actor Visible/Invisible toggle. Independent for every
 * actor in a replay (stored as actor.hidden on this actor's own record),
 * same pattern as every other per-actor field on this menu - toggling one
 * actor never touches any other actor's record.
 */
async function openVisibilityMenu(player, replayId, actorPlayerId, opts = {}) {
    const record = getReplay(replayId);
    if (!record) return openReplayEditorMenu(player, replayId);
    const actor = record.actors.find((a) => a.playerId === actorPlayerId);
    if (!actor) return openReplayEditorMenu(player, replayId);

    const hidden = !!actor.hidden;

    const form = new ActionFormData()
        .title("§6Visibility")
        .body(`§7Current: ${hidden ? "§cInvisible" : "§aVisible"}\n§r§8Only affects this replay actor - other actors are unaffected.`)
        .button(hidden ? "Visible" : "§a✔ Visible")
        .button(hidden ? "§3✔ Invisible" : "Invisible")
        .button("§3« Back");

    premiumSection(form, "ACTOR STUDIO", "Visibility");
    const response = await form.show(player);
    if (response.canceled) return;

    switch (response.selection) {
        case 0:
            if (hidden) {
                updateActor(replayId, actorPlayerId, { hidden: false });
                liveApplyVisibilityIfPlaying(replayId, actorPlayerId, false);
                player.sendMessage("§a✔ Actor set to Visible.");
            }
            return openVisibilityMenu(player, replayId, actorPlayerId, opts);
        case 1:
            if (!hidden) {
                updateActor(replayId, actorPlayerId, { hidden: true });
                liveApplyVisibilityIfPlaying(replayId, actorPlayerId, true);
                player.sendMessage("§a✔ Actor set to Invisible.");
            }
            return openVisibilityMenu(player, replayId, actorPlayerId, opts);
        case 2:
            return openReplayActorMenu(player, replayId, actorPlayerId, opts);
    }
}

/** Top-level Armor menu - one row per slot (Helmet/Chestplate/Leggings/Boots), showing the currently-set tier if any, routing to a per-slot tier picker. */
async function openArmorMenu(player, replayId, actorPlayerId, opts = {}) {
    const record = getReplay(replayId);
    if (!record) return openReplayEditorMenu(player, replayId);
    const actor = record.actors.find((a) => a.playerId === actorPlayerId);
    if (!actor) return openReplayEditorMenu(player, replayId);

    const armor = actor.armor || {};
    const form = new ActionFormData().title("§6Armor").body("§7Pick a piece to set (or clear) its tier - only affects this replay actor.");
    for (const slotDef of ARMOR_SLOTS) {
        const current = armor[slotDef.key];
        const currentLabel = current && current.typeId ? tierLabelFromItemId(current.typeId, slotDef.suffix) : "empty";
        form.button(`§2${slotDef.label}\n§r§8${currentLabel}`);
    }
    form.button("§3« Back");

    premiumSection(form, "ACTOR STUDIO", "Armor");
    const response = await form.show(player);
    if (response.canceled) return;

    if (response.selection === ARMOR_SLOTS.length) {
        return openReplayActorMenu(player, replayId, actorPlayerId, opts);
    }

    const slotDef = ARMOR_SLOTS[response.selection];
    return openArmorTierPicker(player, replayId, actorPlayerId, slotDef, opts);
}

/** Finds the display label for a tier from a built item identifier (e.g. "minecraft:iron_helmet" + "_helmet" -> "Iron"), for showing the current selection in the Armor menu without storing the label separately. Elytra is checked first since it has no material-tier suffix to strip. */
function tierLabelFromItemId(typeId, suffix) {
    if (typeId === "minecraft:elytra") return "Elytra";
    const withoutPrefix = typeId.replace("minecraft:", "");
    const tierId = withoutPrefix.endsWith(suffix) ? withoutPrefix.slice(0, -suffix.length) : withoutPrefix;
    const tier = ARMOR_TIERS.find((t) => t.id === tierId);
    return tier ? tier.label : withoutPrefix;
}

/** Per-slot tier picker (Leather through Netherite, plus Clear) for one armor slot - writes the built vanilla item identifier straight into actor.armor[slotDef.key]. */
async function openArmorTierPicker(player, replayId, actorPlayerId, slotDef, opts = {}) {
    const record = getReplay(replayId);
    if (!record) return openReplayEditorMenu(player, replayId);
    const actor = record.actors.find((a) => a.playerId === actorPlayerId);
    if (!actor) return openReplayEditorMenu(player, replayId);

    const armor = actor.armor || {};
    const current = armor[slotDef.key];
    const isElytraSlot = slotDef.key === "chest";

    const form = new ActionFormData()
        .title(`§6${slotDef.label}`)
        .body("§7Pick a tier for this replay actor - only affects this replay.");

    for (const tier of ARMOR_TIERS) {
        const itemId = `minecraft:${tier.id}${slotDef.suffix}`;
        const marker = current && current.typeId === itemId ? "§a✔ " : "§b";
        form.button(`${marker}${tier.label}`);
    }

    if (isElytraSlot) {
        const elytraMarker = current && current.typeId === "minecraft:elytra" ? "§a✔ " : "§b";
        form.button(`${elytraMarker}Elytra`);
    }

    form.button("§3✖ Clear");
    form.button("§3« Back");

    premiumSection(form, "ACTOR STUDIO", slotDef.label);
    const response = await form.show(player);
    if (response.canceled) return;

    const elytraIndex = isElytraSlot ? ARMOR_TIERS.length : -1;
    const clearIndex = isElytraSlot ? ARMOR_TIERS.length + 1 : ARMOR_TIERS.length;
    const backIndex = isElytraSlot ? ARMOR_TIERS.length + 2 : ARMOR_TIERS.length + 1;

    if (response.selection === backIndex) {
        return openArmorMenu(player, replayId, actorPlayerId, opts);
    }

    const nextArmor = { ...armor };

    if (response.selection === clearIndex) {
        delete nextArmor[slotDef.key];
        updateActor(replayId, actorPlayerId, { armor: nextArmor });
        liveApplyIfPlaying(replayId, actorPlayerId, slotDef.key, undefined);
        player.sendMessage(`§a✔ Cleared §b${slotDef.label}§a for this replay actor.`);
    } else if (response.selection === elytraIndex) {
        nextArmor[slotDef.key] = { typeId: "minecraft:elytra", amount: 1 };
        updateActor(replayId, actorPlayerId, { armor: nextArmor });
        liveApplyIfPlaying(replayId, actorPlayerId, slotDef.key, "minecraft:elytra");
        player.sendMessage(`§a✔ Set §b${slotDef.label}§a to §bElytra§a for this replay actor.`);
    } else if (response.selection >= 0 && response.selection < ARMOR_TIERS.length) {
        const tier = ARMOR_TIERS[response.selection];
        const typeId = `minecraft:${tier.id}${slotDef.suffix}`;
        nextArmor[slotDef.key] = { typeId, amount: 1 };
        updateActor(replayId, actorPlayerId, { armor: nextArmor });
        liveApplyIfPlaying(replayId, actorPlayerId, slotDef.key, typeId);
        player.sendMessage(`§a✔ Set §b${slotDef.label}§a to §b${tier.label}§a for this replay actor.`);
    }

    return openArmorMenu(player, replayId, actorPlayerId, opts);
}

/** Held Item menu - one picker each for Main Hand and Off Hand, from a practical shortlist of common vanilla items. */
async function openHeldItemMenu(player, replayId, actorPlayerId, opts = {}) {
    const record = getReplay(replayId);
    if (!record) return openReplayEditorMenu(player, replayId);
    const actor = record.actors.find((a) => a.playerId === actorPlayerId);
    if (!actor) return openReplayEditorMenu(player, replayId);

    const armor = actor.armor || {};
    const mainhandLabel = armor.mainhand && armor.mainhand.typeId ? heldItemLabelFromId(armor.mainhand.typeId) : "empty";
    const offhandLabel = armor.offhand && armor.offhand.typeId ? heldItemLabelFromId(armor.offhand.typeId) : "empty";

    const form = new ActionFormData()
        .title("§6Held Item")
        .body("§7Pick an item to set (or clear) for this replay actor - only affects this replay.")
        .button(`§3Main Hand\n§r§8${mainhandLabel}`)
        .button(`§3Off Hand\n§r§8${offhandLabel}`)
        .button("§3« Back");

    premiumSection(form, "ACTOR STUDIO", "Held Item");
    const response = await form.show(player);
    if (response.canceled) return;

    if (response.selection === 0) return openHeldItemPicker(player, replayId, actorPlayerId, "mainhand", "Main Hand", opts);
    if (response.selection === 1) return openHeldItemPicker(player, replayId, actorPlayerId, "offhand", "Off Hand", opts);
    return openReplayActorMenu(player, replayId, actorPlayerId, opts);
}

function heldItemLabelFromId(typeId) {
    const choice = HELD_ITEM_CHOICES.find((c) => c.id === typeId);
    return choice ? choice.label : typeId.replace("minecraft:", "");
}

/** Item picker for one held-item slot (mainhand or offhand). */
async function openHeldItemPicker(player, replayId, actorPlayerId, slotKey, slotLabel, opts = {}) {
    const record = getReplay(replayId);
    if (!record) return openReplayEditorMenu(player, replayId);
    const actor = record.actors.find((a) => a.playerId === actorPlayerId);
    if (!actor) return openReplayEditorMenu(player, replayId);

    const armor = actor.armor || {};
    const current = armor[slotKey];

    const form = new ActionFormData().title(`§6${slotLabel}`).body("§7Pick an item for this replay actor - only affects this replay.");
    for (const choice of HELD_ITEM_CHOICES) {
        const marker = current && current.typeId === choice.id ? "§a✔ " : "§b";
        form.button(`${marker}${choice.label}`);
    }
    form.button("§3✖ Clear");
    form.button("§3« Back");

    premiumSection(form, "ACTOR STUDIO", slotLabel);
    const response = await form.show(player);
    if (response.canceled) return;

    if (response.selection === HELD_ITEM_CHOICES.length + 1) {
        return openHeldItemMenu(player, replayId, actorPlayerId, opts);
    }

    const nextArmor = { ...armor };
    if (response.selection === HELD_ITEM_CHOICES.length) {
        delete nextArmor[slotKey];
        updateActor(replayId, actorPlayerId, { armor: nextArmor });
        liveApplyIfPlaying(replayId, actorPlayerId, slotKey, undefined);
        player.sendMessage(`§a✔ Cleared §b${slotLabel}§a for this replay actor.`);
    } else {
        const choice = HELD_ITEM_CHOICES[response.selection];
        nextArmor[slotKey] = { typeId: choice.id, amount: 1 };
        updateActor(replayId, actorPlayerId, { armor: nextArmor });
        liveApplyIfPlaying(replayId, actorPlayerId, slotKey, choice.id);
        player.sendMessage(`§a✔ Set §b${slotLabel}§a to §b${choice.label}§a for this replay actor.`);
    }

    return openHeldItemMenu(player, replayId, actorPlayerId, opts);
}

