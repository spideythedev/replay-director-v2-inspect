/**
 * Replay Director - Mob Support Table (Record & Replay Mobs pass, v1)
 *
 * Single source of truth for dedicated replay puppets. The playback system
 * can also use a generic vanilla-entity fallback for mob-family types that
 * do not have a dedicated puppet. That fallback is important for preserving
 * native Bedrock rendering and death behavior for species such as cow, sheep,
 * and villagers.
 *
 * Dedicated puppet scope:
 * - zombie
 * - skeleton
 * - pig
 *
 * Cow is intentionally NOT a dedicated puppet. It previously used a custom
 * hand-authored death animation, which replaced the native Bedrock cow death
 * sequence and caused the regression reported by the user. By leaving cow
 * out of this table, getPuppetTypeFor("minecraft:cow") returns undefined and
 * spawnMobActor() uses the generic vanilla cow. At the recorded death tick,
 * syncMobLifecycle() calls Entity.kill(), allowing Bedrock's own cow death
 * lifecycle/animation to run naturally.
 *
 * This same generic fallback is already how sheep/villagers are replayed,
 * which is the behavioral reference for the cow fix.
 *
 * The table below therefore means "has a dedicated puppet", not "is the only
 * mob that Replay Director can record."
 */

/**
 * @type {Record<string, {puppetType:string, displayName:string}>}
 * Keyed by the real vanilla typeId this entry matches during recording.
 * puppetType is the custom entity identifier (this pack's own namespace,
 * "replay:mob_<kind>") spawned during playback - never the vanilla
 * typeId itself, since playback is designed to use the pack's replay mob definitions.
 */
export const SUPPORTED_MOB_TYPES = {};

export const PROJECTILE_PUPPETS = {
    "minecraft:snowball": { puppetType: "replay:projectile_snowball", displayName: "Snowball" },
    "minecraft:ender_pearl": { puppetType: "replay:projectile_ender_pearl", displayName: "Ender Pearl" }
};

export function isReplayProjectileType(typeId) {
    return Object.prototype.hasOwnProperty.call(PROJECTILE_PUPPETS, typeId);
}

/** @param {string} typeId @returns {boolean} */
export function isMobTypeSupported(typeId) {
    return Object.prototype.hasOwnProperty.call(SUPPORTED_MOB_TYPES, typeId);
}

/** @param {string} typeId @returns {string|undefined} the puppet entity identifier to spawn during playback for this vanilla typeId, or undefined if unsupported */
export function getPuppetTypeFor(typeId) {
    const projectileEntry = PROJECTILE_PUPPETS[typeId];
    return projectileEntry ? projectileEntry.puppetType : undefined;
}

/** @param {string} typeId @returns {string} a human-readable name for UI/menu use, falling back to the raw typeId if somehow not in the table */
export function getMobDisplayName(typeId) {
    const entry = SUPPORTED_MOB_TYPES[typeId] || PROJECTILE_PUPPETS[typeId];
    return entry ? entry.displayName : typeId;
}
