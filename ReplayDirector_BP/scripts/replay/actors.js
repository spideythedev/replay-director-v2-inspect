/**
 * Replay Director - Replay Actors (Phase 3D core, animation added in stabilization
 * pass, rotation/blend fixes added in the Replay Actor Improvements pass)
 *
 * Thin wrapper around the replay:actor custom entity: spawning it with the
 * right skin/name, driving its transform each tick from recorded data, and
 * cleaning it up. No independent behavior or physics - it is fully controlled here.
 *
 * Animation status (be honest about this - it needs in-game confirmation):
 * the actor drives its own transform via teleport() every tick rather than
 * real physics/velocity, so engine-computed animation queries like
 * query.ground_speed can't be trusted to reflect anything for it. Instead,
 * this uses entity properties we set ourselves every tick (the same
 * mechanism the skin system already proved works) to drive a walk/run
 * blend in the resource pack. That movement blend is implemented with
 * reasonable confidence (documented vanilla animation shortnames). Sneak
 * pose, swim pose, jump pose, and per-item held poses (bow/crossbow/
 * trident/shield/eating/drinking) are NOT wired to a visual yet - the
 * state IS captured/tracked (see the properties below) so wiring the
 * visual side later is just resource-pack work, not more data plumbing -
 * but guessing several more specific vanilla animation identifiers blind,
 * for something this visually obvious, risks shipping a broken-looking
 * pose. Those need a confirmed identifier before they're wired.
 *
 * Replay Actor Improvements pass (resource-pack only, nothing here changed):
 * the walk cycle's leg/arm swing no longer snaps to bind pose the instant
 * movement stops - it now blends out over 0.2s via a real animation
 * controller state transition (confirmed vanilla blend_transition, not a
 * guessed mechanism). Head/body rotation no longer uses
 * animation.humanoid.look_at_target.default, which required a
 * minecraft:behavior.look_at_* targeting component the actor never had (so it had
 * no real target and wasn't reproducing anything from the recording) - the
 * head bone now tracks the actual recorded rotation this file sets every
 * tick via confirmed vanilla queries (query.target_y_rotation /
 * query.target_x_rotation), offset against query.body_y_rotation (the
 * engine's own natural body-yaw lag, the same mechanism vanilla
 * players/mobs use), which is what makes the body catch up to a turn
 * instead of snapping with it. Only ONE combined rotation is ever
 * captured/set per tick here (documented limitation below still applies,
 * nothing new was captured) - this pass only fixed how that one existing
 * value gets applied to the model, using confirmed real Molang queries
 * instead of a non-functional animation.
 *
 * Armor & Held Item Replay pass (v1 - /replaceitem, now superseded):
 * the original attempt applied equipment via /replaceitem entity @s
 * slot.armor.* commands, reasoning that EntityEquippableComponent was
 * confirmed player-only and /replaceitem operated below that restriction.
 * This did not render - enable_attachables being true is necessary but not
 * sufficient on a fully custom entity; Bedrock's client only extends real
 * armor/held-item rendering to entities the engine specifically recognizes
 * as equipment-capable (real players, and vanilla mobs Mojang hardcoded
 * this into), and a from-scratch entity never gets that regardless of
 * enable_attachables or which command/API sets the item data.
 *
 * Armor & Held Item Replay pass (v2 - runtime_identifier, current):
 * the BP entity description now declares
 * "runtime_identifier": "minecraft:npc" (see
 * ReplayDirector_BP/entities/replay_actor.json) - a documented mechanism
 * that grants a custom entity specific hardcoded engine behaviors from a
 * real vanilla identifier while keeping our own identifier (replay:actor),
 * family, properties, and RP presentation completely untouched. This was
 * chosen deliberately over renaming the entity to minecraft:npc outright,
 * which would work but would globally re-skin/re-behavior every NPC in
 * the world (including other packs' and vanilla /dialogue NPCs) since
 * Bedrock has no way to scope a same-identifier override to only
 * server-spawned instances.
 * IMPORTANT HONESTY NOTE: armor/attachable rendering is not on Bedrock
 * Wiki's documented list of minecraft:npc's known runtime_identifier
 * effects (that list only documents despawn-on-punch and health-ignoring
 * behavior) - that page states outright it isn't exhaustive, so this is a
 * reasonable bet, not a confirmed-working mechanism. If armor still does
 * not render after this change, the runtime_identifier bet was wrong and
 * the remaining options are: rename the entity outright to minecraft:npc
 * (global override tradeoff), or ship without armor rendering as a known
 * limitation. Needs in-game confirmation before this note is updated.
 *
 * Armor & Held Item Replay pass (v3 - /replaceitem via entity.runCommand,
 * current and confirmed working): the v2 EntityEquippableComponent
 * approach was root-caused and abandoned - getComponent("minecraft:
 * equippable") returns undefined on this entity, and a control probe
 * spawning a vanilla minecraft:wolf (a mob Mojang's own wolf.json declares
 * should have this component) got the same undefined result, confirming
 * the failure sits in the Script API's component accessor, not something
 * specific to replay:actor. The "known Bedrock bug" concern from v1 is no
 * longer the operative one - v1 failed for a different reason entirely
 * (a from-scratch custom entity isn't extended real armor/held-item
 * rendering by the client regardless of which command/API sets the item
 * data, unless the engine specifically recognizes it as equipment-capable).
 * In-game testing (both manually-typed chat commands and
 * entity.runCommand() from script) confirmed /replaceitem entity @s
 * slot.X 0 <item> 1 DOES render correctly here for weapon.mainhand,
 * weapon.offhand, and armor.head - meaning the equipment container and its
 * rendering were never actually broken, only the component accessor was.
 * All equipment work now goes through ../replay/equipment.js
 * (setActorEquipment/clearActorEquipment/applyActorEquipment), which
 * drives every slot via entity.runCommand("replaceitem ..."). This file
 * only re-exports the two entry points playback.js already calls
 * (updateActorEquipment, clearActorEquipment) so playback.js needed no
 * changes.
 */

import { system } from "@minecraft/server";
import { REPLAY_SKINS } from "../core/replaySkins.js";
import { rdLog, rdWarn, rdError } from "../core/debugLog.js";
import { applyActorEquipment, clearActorEquipment as clearEquipmentSlots, equipmentMapsEqual } from "./equipment.js";

const ACTOR_TYPE = "replay:actor";
const MOVING_SPEED_THRESHOLD = 0.02; // blocks/tick - matches capture.js's own velocity epsilon

/**
 * @param {import("@minecraft/server").Dimension} dimension
 * @param {{x:number,y:number,z:number}} location
 * @param {object} actorRecord - one entry from a saved replay's `actors` array
 * @param {number} [ashTagIndex] - 1-based index for this actor within the current playback session, used to tag the entity "ash1", "ash2", ... so it can be targeted with a plain @e[tag=ashN] selector (chat commands, other tools, or future features) independent of the Entity reference this function returns. Omit to skip tagging (e.g. a caller that doesn't need it).
 * @returns {import("@minecraft/server").Entity|undefined}
 */
export function spawnActor(dimension, location, actorRecord, ashTagIndex) {
    let entity;
    try {
        entity = dimension.spawnEntity(ACTOR_TYPE, location);
    } catch (e) {
        rdError(`spawnActor: dimension.spawnEntity("${ACTOR_TYPE}") THREW - actor was not spawned.`, e);
        return undefined;
    }

    if (!entity) {
        rdError(`spawnActor: dimension.spawnEntity("${ACTOR_TYPE}") returned no entity (no exception thrown).`);
        return undefined;
    }

    rdLog(`spawnActor: SPAWNED OK. id=${entity.id} typeId=${entity.typeId}`);
    try {
        // runtime_identifier is not exposed on the script API Entity object
        // directly - typeId always reflects the *behavior file* identifier
        // (replay:actor), never the runtime_identifier substitution
        // (minecraft:npc) declared in entities/replay_actor.json. Logged
        // here explicitly since the task asks to verify this.
        rdLog(`spawnActor: entity.typeId="${entity.typeId}" (script API has no direct runtime_identifier accessor; runtime_identifier is a BP-file-only field and is NOT reflected in entity.typeId or elsewhere on the Entity object)`);
    } catch (e) {
        rdWarn(`spawnActor: failed reading back entity.typeId after spawn.`);
    }

    // ashN tag - a plain, chat-testable selector for this specific fake
    // player (@e[tag=ash1], @e[tag=ash2], ...), assigned in spawn order for
    // this playback session. Independent of the Entity reference this
    // function returns - lets any command/tool/future feature target one
    // specific actor by tag instead of needing that reference.
    if (ashTagIndex) {
        try {
            entity.addTag(`ash${ashTagIndex}`);
            rdLog(`spawnActor: tagged entity id=${entity.id} with "ash${ashTagIndex}".`);
        } catch (e) {
            rdError(`spawnActor: entity.addTag("ash${ashTagIndex}") THREW on entity id=${entity.id}.`, e);
        }
    }

    try {
        const rawName = actorRecord.displayName || actorRecord.playerName || "";
        entity.nameTag = actorRecord.nameTagVisible === false ? "" : `${actorRecord.nameColor || ""}${rawName}`;
        const skinIndex = REPLAY_SKINS.findIndex((s) => s.id === actorRecord.skinId);
        entity.setProperty("replay:skin_index", skinIndex >= 0 ? skinIndex : 0);
    } catch (e) {
        rdError(`spawnActor: setting nameTag/skin property threw (actor still exists).`, e);
    }

    // Player Visibility (QoL pass): PER-ACTOR now, not a global setting -
    // set via the Replay Actor menu (Visible/Invisible), stored as
    // actorRecord.hidden, same pattern as actorRecord.armor/nameTagVisible
    // above. Applied as a standing invisibility effect - needs no entity
    // JSON/render-controller changes, and each actor's toggle is fully
    // independent since it's just this one record's field. showParticles:
    // false so no "poof" particle betrays a hidden actor's position; a
    // very long duration since actors live for the length of playback,
    // not 1 tick. Nothing else here changes - timeline, playback, camera,
    // and recording never read this field.
    if (actorRecord.hidden) {
        try {
            entity.addEffect("invisibility", 20000000, { amplifier: 0, showParticles: false });
        } catch (e) {
            rdError(`spawnActor: applying invisibility effect threw (actor still exists, may remain visible).`, e);
        }
    }

    // Manual per-actor equipment override (actorRecord.armor, set via the
    // Replay Actor menu's Armor/Held Item pickers) - separate from any
    // recorded per-tick equipment, which playback.js applies afterward via
    // updateActorEquipment(). Applying it here first means a replay with no
    // recorded equipment data still shows a manually-set fixed outfit, and
    // one WITH recorded data simply gets overwritten a moment later by the
    // first recorded frame, same as any other "spawn default, then let
    // playback drive it" field on this entity. Deferred one tick - a
    // freshly spawned entity isn't always ready for entity.runCommand() on
    // the very tick it spawns.
    if (actorRecord.armor) {
        system.run(() => {
            if (entity.isValid) applyActorEquipment(entity, actorRecord.armor);
        });
    }

    return entity;
}

export function updateActorTransform(entity, location, rotation) {
    if (!entity || !entity.isValid) return;
    try {
        entity.teleport(location, { rotation: { x: rotation.pitch, y: rotation.yaw } });
    } catch (e) {
        // fail soft - one bad frame shouldn't stop the whole playback
    }
}

/**
 * Smoothly blends between two recorded frames instead of snapping straight
 * to one - this is what makes slow-motion (and any speed, really) look
 * fluid instead of stepping frame-to-frame. Position lerps normally; yaw
 * takes the shortest angular path around the 360-degree wrap so an actor
 * turning from e.g. 179 to -179 degrees doesn't spin the long way around.
 * @param {import("@minecraft/server").Entity} entity
 * @param {{x:number,y:number,z:number,yaw:number,pitch:number}} fromState
 * @param {{x:number,y:number,z:number,yaw:number,pitch:number}} toState
 * @param {number} t - blend factor, 0 = fromState, 1 = toState
 */
export function updateActorTransformInterpolated(entity, fromState, toState, t) {
    if (!entity || !entity.isValid) return;
    try {
        const clampedT = Math.max(0, Math.min(1, t));
        const x = lerp(fromState.x, toState.x, clampedT);
        const y = lerp(fromState.y, toState.y, clampedT);
        const z = lerp(fromState.z, toState.z, clampedT);
        const yaw = lerpAngle(fromState.yaw, toState.yaw, clampedT);
        const pitch = lerp(fromState.pitch, toState.pitch, clampedT);

        entity.teleport({ x, y, z }, { rotation: { x: pitch, y: yaw } });
    } catch (e) {
        // fail soft - one bad frame shouldn't stop the whole playback
    }
}

function lerp(a, b, t) {
    return a + (b - a) * t;
}

/** Interpolates an angle in degrees taking the shortest path around the wrap. */
function lerpAngle(a, b, t) {
    let diff = ((b - a + 180) % 360 + 360) % 360 - 180;
    return a + diff * t;
}

/**
 * Classifies a held item's typeId into the pose categories the client
 * entity's replay:item_pose enum understands. Based on real vanilla
 * item identifiers (bow/crossbow/trident/shield are unambiguous by
 * typeId), not guessed - anything else falls back to "none" (generic
 * hold, which the base move/attack animations already cover).
 * @param {string|undefined} typeId
 * @returns {"none"|"bow"|"crossbow"|"trident"|"shield"}
 */
function classifyHeldItemPose(typeId) {
    if (!typeId) return "none";
    if (typeId === "minecraft:bow") return "bow";
    if (typeId === "minecraft:crossbow") return "crossbow";
    if (typeId === "minecraft:trident") return "trident";
    if (typeId === "minecraft:shield") return "shield";
    return "none";
}

/**
 * Whether a held item is something eaten/drunk when used - real vanilla
 * food/potion identifiers, used together with the recorded `usingItem`
 * flag to distinguish eating/drinking from bow-draw/shield-block (which
 * use the same "is using the held item" moment but need a different pose).
 * @param {string|undefined} typeId
 * @returns {"none"|"eating"|"drinking"}
 */
function classifyConsumablePose(typeId) {
    if (!typeId) return "none";
    if (typeId.includes("potion") || typeId === "minecraft:milk_bucket" || typeId === "minecraft:honey_bottle") {
        return "drinking";
    }
    // Foods are the large remaining vanilla edible set - there's no single
    // shared substring for all of them, so this checks the common ones
    // rather than guessing at an exhaustive list; anything not matched
    // here or above just won't get the eating pose, which fails safe
    // (falls back to holding the item, not to some wrong animation).
    const FOODS = [
        "apple", "bread", "beef", "porkchop", "chicken", "mutton", "rabbit",
        "cod", "salmon", "carrot", "potato", "beetroot", "melon_slice",
        "cookie", "pumpkin_pie", "cake", "chorus_fruit", "sweet_berries",
        "glow_berries", "dried_kelp", "stew", "suspicious_stew"
    ];
    return FOODS.some((f) => typeId.endsWith(f)) ? "eating" : "none";
}

/**
 * Sets the movement-state properties the render/animation script reads.
 * Every value here comes from actual recorded data (capture.js's
 * buildState) - nothing here infers state that wasn't really captured.
 * @param {import("@minecraft/server").Entity} entity
 * @param {object} state - the recorded frame's state object (from capture.js's buildState)
 */
export function updateActorAnimationState(entity, state) {
    if (!entity || !entity.isValid) return;
    try {
        // Once the recording's death event has fired for this actor, hold
        // the death pose - don't let the next frame's movement flags
        // overwrite it (a recorded corpse obviously has vx/vy/vz noise from
        // the moment of death, but shouldn't visually start walking again).
        if (entity.getProperty("replay:dead")) return;

        const groundSpeed = Math.hypot(state.vx ?? 0, state.vz ?? 0);
        entity.setProperty("replay:moving", groundSpeed > MOVING_SPEED_THRESHOLD);
        entity.setProperty("replay:sprinting", !!state.sprinting);
        entity.setProperty("replay:sneaking", !!state.sneaking);
        entity.setProperty("replay:swimming", !!state.swimming);
        entity.setProperty("replay:jumping", !!state.jumping);
        // Falls back to false for older saved replays recorded before
        // gliding was captured, same fallback pattern as onGround/climbing/
        // falling below - undefined reads as falsy here rather than
        // throwing or defaulting to "always gliding".
        entity.setProperty("replay:gliding", !!state.gliding);

        // New, from real captured fields (isOnGround/isClimbing/isFalling,
        // heldItemTypeId, usingItem) - falls back to false/"none" for older
        // saved replays recorded before these fields existed, since
        // undefined reads as falsy here rather than throwing.
        entity.setProperty("replay:on_ground", state.onGround !== false);
        entity.setProperty("replay:climbing", !!state.climbing);
        entity.setProperty("replay:falling", !!state.falling);

        const weaponPose = classifyHeldItemPose(state.heldItemTypeId);
        if (state.usingItem && weaponPose !== "none") {
            entity.setProperty("replay:item_pose", weaponPose);
        } else if (state.usingItem) {
            const consumablePose = classifyConsumablePose(state.heldItemTypeId);
            entity.setProperty("replay:item_pose", consumablePose);
        } else {
            entity.setProperty("replay:item_pose", "none");
        }
    } catch (e) {
        // fail soft - properties may be unavailable on this API version
    }
}

/**
 * Classifies a held item's typeId into a swing-animation category. Real
 * vanilla item identifiers only - the "sword"/"axe"/"pickaxe" families all
 * share a consistent _sword/_axe/_pickaxe suffix across every material
 * tier, so a suffix check covers all tiers without listing each one; mace
 * and trident are single unique identifiers. Anything unmatched (including
 * an empty hand) falls back to "hand" - the existing generic swing, so
 * nothing new is required to keep the current behavior for untyped items.
 * @param {string|undefined} typeId
 * @returns {"hand"|"sword"|"axe"|"pickaxe"|"mace"|"trident"}
 */
function classifySwingType(typeId) {
    if (!typeId) return "hand";
    if (typeId === "minecraft:mace") return "mace";
    if (typeId === "minecraft:trident") return "trident";
    if (typeId.endsWith("_sword")) return "sword";
    if (typeId.endsWith("_axe")) return "axe";
    if (typeId.endsWith("_pickaxe") || typeId.endsWith("_shovel") || typeId.endsWith("_hoe")) return "pickaxe";
    return "hand";
}

/** Brief pulse for a one-shot action like item use - see file header on which poses are wired vs tracked-only. Only needs to stay true for a couple of ticks: the swing controller now exits on query.all_animations_finished (the animation's own natural length), not on this property staying true, so a short pulse is enough to trigger entry and the animation is never cut short or held hostage to durationTicks. @param {string} [swingType] one of classifySwingType()'s categories - defaults to "hand" (the original generic swing) when omitted, so existing callers that don't pass one keep working unchanged. */
export function triggerUsePulse(entity, system, durationTicks = 3, swingType = "hand") {
    if (!entity || !entity.isValid) return;
    try {
        entity.setProperty("replay:swing_type", swingType);
        entity.setProperty("replay:use_pulse", true);
        system.runTimeout(() => {
            try {
                if (entity.isValid) entity.setProperty("replay:use_pulse", false);
            } catch (e) {
                // fail soft
            }
        }, durationTicks);
    } catch (e) {
        // fail soft
    }
}

/** Brief attack-swing pulse, fired on the attacking player's actor when the recording's entityHurt event replays and had a player attacker. Reuses the same replay:use_pulse property/Molang binding as item_use, tagged with the attacker's recorded weapon typeId so sword/axe/mace/trident/bare-hand each play their own full-length swing regardless of durationTicks (see triggerUsePulse). @param {string|undefined} [weaponTypeId] events.js's recorded attackerWeaponTypeId for this hit. */
export function triggerAttackPulse(entity, system, durationTicks = 3, weaponTypeId = undefined) {
    triggerUsePulse(entity, system, durationTicks, classifySwingType(weaponTypeId));
}

/** Brief mining-swing pulse, fired on the recording's block_break event replaying - see events.js/eventPlayback.js for why this is a discrete pulse rather than a continuous held-mining animation (no confirmed per-tick "still mining" data exists to drive one). Tagged with the recorded tool typeId so a pickaxe/axe/shovel/hoe/bare-hand each play their own full-length mining swing. @param {string|undefined} [toolTypeId] events.js's recorded toolTypeId for this break. */
export function triggerMiningPulse(entity, system, durationTicks = 3, toolTypeId = undefined) {
    triggerUsePulse(entity, system, durationTicks, classifySwingType(toolTypeId));
}

/** Brief block-place pulse, fired on the recording's block_place event replaying. Uses its own replay:place_pulse property, kept independent from replay:use_pulse/swing_type - placement always plays the same short generic swing regardless of what's held, and giving it a separate trigger means a placement can never be starved or overridden by a same-tick attack/mining pulse (or vice versa). Like the swing controller, the place controller now exits on query.all_animations_finished, so this only needs to stay true briefly. events.js records a toolTypeId for block_place/block_break too, but it's intentionally unused here since a real player's placement animation doesn't change by tool. */
export function triggerPlacePulse(entity, system, durationTicks = 3) {
    if (!entity || !entity.isValid) return;
    try {
        entity.setProperty("replay:place_pulse", true);
        system.runTimeout(() => {
            try {
                if (entity.isValid) entity.setProperty("replay:place_pulse", false);
            } catch (e) {
                // fail soft
            }
        }, durationTicks);
    } catch (e) {
        // fail soft
    }
}

/** One-shot landing pulse (auto-clears) - fired by playback.js when it detects falling -> on-ground transition between two consecutive recorded frames for this actor. */
export function triggerLandingPulse(entity, system, durationTicks = 4) {
    if (!entity || !entity.isValid) return;
    try {
        entity.setProperty("replay:landing_pulse", true);
        system.runTimeout(() => {
            try {
                if (entity.isValid) entity.setProperty("replay:landing_pulse", false);
            } catch (e) {
                // fail soft
            }
        }, durationTicks);
    } catch (e) {
        // fail soft
    }
}

/** Brief red hurt-flash pulse (auto-clears), fired when the recording's entityHurt event replays for this actor. */
export function triggerHurtPulse(entity, system, durationTicks = 5) {
    if (!entity || !entity.isValid) return;
    try {
        entity.setProperty("replay:hurt_pulse", true);
        system.runTimeout(() => {
            try {
                if (entity.isValid) entity.setProperty("replay:hurt_pulse", false);
            } catch (e) {
                // fail soft
            }
        }, durationTicks);
    } catch (e) {
        // fail soft
    }
}

/**
 * Marks this actor as dead (recording's death event replaying) and holds it
 * in a lying-down pose. The actor entity itself is NOT removed here - per
 * the stabilization requirement, actors must never disappear unexpectedly;
 * a dead actor just stays visible in its final death pose until playback
 * ends and the whole actor set is cleaned up normally.
 * @param {import("@minecraft/server").Entity} entity
 */
export function markActorDead(entity) {
    if (!entity || !entity.isValid) return;
    try {
        entity.setProperty("replay:dead", true);
        entity.setProperty("replay:moving", false);
        entity.setProperty("replay:sprinting", false);
        // Lying-down pose: pitch the whole entity, same mechanism transform
        // updates already use - no new rendering primitive, just an
        // extreme pitch value applied through the existing teleport path.
        const loc = entity.location;
        const rot = entity.getRotation();
        entity.teleport(loc, { rotation: { x: 90, y: rot.y } });
    } catch (e) {
        // fail soft
    }
}

/**
 * Reverses markActorDead - clears the held death pose/property so normal
 * per-tick transform/animation updates resume driving this actor again.
 * Used when playback seeks (or restarts) to a moment before the recorded
 * death event, so rewinding past a death doesn't leave the actor stuck
 * lying down for the rest of the session (Replay Playback Accuracy pass -
 * playback must stay deterministic and reflect the recorded timeline
 * exactly, in either direction).
 * @param {import("@minecraft/server").Entity} entity
 */
export function reviveActor(entity) {
    if (!entity || !entity.isValid) return;
    try {
        entity.setProperty("replay:dead", false);
    } catch (e) {
        // fail soft
    }
}

/**
 * @param {import("@minecraft/server").Entity} entity
 */
export function removeActor(entity) {
    if (!entity || !entity.isValid) return;
    try {
        entity.remove();
    } catch (e) {
        // fail soft
    }
}

/**
 * Applies a recorded equipment snapshot (see capture.js's
 * buildEquipmentSnapshot) to a Replay Actor via ../replay/equipment.js's
 * applyActorEquipment() (/replaceitem-based - see this file's header for
 * why). Only actually-changed slots trigger a command, via
 * equipmentMapsEqual, so a per-tick call during normal playback doesn't
 * spam /replaceitem for a held item that hasn't changed in ages. Same
 * function name/signature playback.js already calls - only the
 * implementation underneath changed.
 * @param {import("@minecraft/server").Entity} entity
 * @param {object|undefined} equipment - this tick's recorded equipment snapshot (may be undefined for older saved replays recorded before this feature existed)
 * @param {object|undefined} previousEquipment - the equipment snapshot last applied to this actor, so unchanged slots can be skipped
 * @returns {object|undefined} the snapshot that was actually applied (pass this back in as previousEquipment next call), or the unchanged previousEquipment if nothing needed to change
 */
export function updateActorEquipment(entity, equipment, previousEquipment) {
    // Unconditional, debug-toggle-independent entry log - this must always
    // fire the instant this function is called, before any early return,
    // so it's possible to confirm playback is actually invoking it at all
    // (separate question from whether the command inside it then succeeds).
    rdLog(`updateActorEquipment: CALLED - entity=${!!entity} isValid=${entity ? entity.isValid : "n/a"} hasEquipmentArg=${!!equipment}`);

    if (!entity || !entity.isValid) {
        rdWarn(`updateActorEquipment: entity missing/invalid - aborting (entity=${!!entity}, isValid=${entity ? entity.isValid : "n/a"}).`);
        return previousEquipment;
    }
    if (!equipment) {
        rdLog(`updateActorEquipment: no equipment snapshot for this frame (undefined) - nothing to apply, entity id=${entity.id}.`);
        return previousEquipment;
    }
    if (equipmentMapsEqual(equipment, previousEquipment)) {
        rdLog(`updateActorEquipment: snapshot unchanged since last apply - skipping (entity id=${entity.id}).`);
        return previousEquipment;
    }

    rdLog(`updateActorEquipment: entity id=${entity.id} typeId=${entity.typeId} - snapshot changed, applying via /replaceitem.`);
    return applyActorEquipment(entity, equipment);
}

/** Clears every equipment slot on an actor - used when seeking to a point before any equipment was recorded (older saved replays) or as a clean starting state on spawn. Same function name/signature playback.js already calls. */
export function clearActorEquipment(entity) {
    clearEquipmentSlots(entity);
}
