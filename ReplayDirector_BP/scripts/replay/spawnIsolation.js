/**
 * Replay Director - Replay Spawn Isolation
 *
 * During playback, suppress newly initialized vanilla mob entities inside the
 * restored 62x62x62 world-snapshot region unless that entity was explicitly
 * requested by the replay lifecycle.
 *
 * This does NOT disable spawning globally, does NOT touch existing loaded
 * mobs, and does NOT suppress projectiles or players. It only handles newly
 * initialized mob-family entities whose initialization cause is a normal
 * spawn/birth/event/transformation while replay isolation is active.
 *
 * Replay-spawned entities are allowed through a short-lived reservation made
 * immediately before spawnEntity() is called. This avoids the old broad
 * "nearby entity suppression" design that could delete legitimate mobs.
 */

import { system, world } from "@minecraft/server";

const SUPPRESSED_CAUSES = new Set(["Spawned", "Born", "Event", "Transformed"]);
const RESERVATION_TTL_TICKS = 5;
const MATCH_DISTANCE_SQUARED = 9; // 3 blocks; only a safety envelope around the exact replay spawn call.

const state = {
    active: false,
    from: undefined,
    to: undefined,
    dimensionId: undefined,
    subscription: undefined,
    reservations: []
};

function isInsideBounds(location) {
    if (!state.from || !state.to || !location) return false;
    return location.x >= state.from.x && location.x <= state.to.x &&
        location.y >= state.from.y && location.y <= state.to.y &&
        location.z >= state.from.z && location.z <= state.to.z;
}

function isMob(entity) {
    if (!entity) return false;
    try {
        return entity.matches({ families: ["mob"] });
    } catch (e) {
        return false;
    }
}

function distanceSquared(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const dz = a.z - b.z;
    return dx * dx + dy * dy + dz * dz;
}

function cleanupReservations() {
    if (state.reservations.length === 0) return;
    state.reservations = state.reservations.filter((reservation) => reservation.expires > 0);
    for (const reservation of state.reservations) reservation.expires -= 1;
}

function consumeReservation(entity) {
    if (!entity) return false;

    for (let i = 0; i < state.reservations.length; i++) {
        const reservation = state.reservations[i];
        if (reservation.typeId !== entity.typeId) continue;
        if (reservation.dimensionId !== entity.dimension.id) continue;
        if (distanceSquared(reservation.location, entity.location) > MATCH_DISTANCE_SQUARED) continue;

        state.reservations.splice(i, 1);
        return true;
    }

    return false;
}

function onEntitySpawn(event) {
    if (!state.active) return;

    const entity = event?.entity;
    if (!entity) return;

    // The event cause is the engine's initialization reason. Loaded entities
    // are intentionally left alone: replay must not delete legitimate mobs
    // that were already in the world and merely became loaded.
    const cause = event?.cause;
    if (!SUPPRESSED_CAUSES.has(cause)) return;
    if (!isMob(entity)) return;
    if (entity.dimension.id !== state.dimensionId) return;
    if (!isInsideBounds(entity.location)) return;

    // Replay actor creation is explicitly reserved immediately before
    // spawnEntity(). All other new mob initialization inside the restored
    // scene is considered unrecorded and is removed.
    if (consumeReservation(entity)) return;

    try {
        entity.remove();
    } catch (e) {
        // Fail soft. A spawn event must never be allowed to destabilize the
        // replay tick if the entity disappears between the event and remove().
    }
}

function subscribe() {
    if (state.subscription) return;
    try {
        state.subscription = world.afterEvents.entitySpawn.subscribe(onEntitySpawn);
    } catch (e) {
        state.subscription = undefined;
    }
}

function unsubscribe() {
    if (!state.subscription) return;
    try {
        world.afterEvents.entitySpawn.unsubscribe(state.subscription);
    } catch (e) {}
    state.subscription = undefined;
}

/**
 * Enables spawn isolation for the exact restored world-snapshot bounds.
 * @param {{from:{x:number,y:number,z:number},to:{x:number,y:number,z:number},dimensionId:string}|undefined} bounds
 */
export function enableReplaySpawnIsolation(bounds) {
    disableReplaySpawnIsolation();

    if (!bounds?.from || !bounds?.to || !bounds?.dimensionId) return false;

    state.active = true;
    state.from = { ...bounds.from };
    state.to = { ...bounds.to };
    state.dimensionId = bounds.dimensionId;
    state.reservations = [];
    subscribe();

    // Reservation expiry is deliberately tiny. This is only a bridge across
    // the spawnEntity -> entitySpawn event, never a general allowlist.
    state.cleanupInterval = system.runInterval(() => {
        if (!state.active) return;
        cleanupReservations();
    }, 1);

    return !!state.subscription;
}

/**
 * Disables replay spawn isolation and clears all temporary state.
 */
export function disableReplaySpawnIsolation() {
    state.active = false;
    unsubscribe();

    if (state.cleanupInterval !== undefined) {
        try { system.clearRun(state.cleanupInterval); } catch (e) {}
    }
    state.cleanupInterval = undefined;

    state.from = undefined;
    state.to = undefined;
    state.dimensionId = undefined;
    state.reservations = [];
}

/**
 * Reserves one replay-created mob so the spawn-isolation event handler allows
 * it through. Must be called immediately before spawnEntity().
 *
 * @param {string} typeId
 * @param {string} dimensionId
 * @param {{x:number,y:number,z:number}} location
 */
export function reserveReplayMobSpawn(typeId, dimensionId, location) {
    if (!state.active || !typeId || !dimensionId || !location) return;

    state.reservations.push({
        typeId,
        dimensionId,
        location: { x: location.x, y: location.y, z: location.z },
        expires: RESERVATION_TTL_TICKS
    });
}

/** @returns {boolean} */
export function isReplaySpawnIsolationActive() {
    return state.active;
}
