/**
 * Replay Director - World Snapshot & Restore
 *
 * Fixed 62x62x62 recording region. The region is split into eight 31x31x31
 * world structures so StructureManager work is spread across script ticks.
 * This keeps the total restored area exactly 62x62x62 while avoiding one
 * oversized synchronous structure operation that can trip the watchdog.
 *
 * Snapshot capture happens BEFORE recording starts. Playback waits for every
 * snapshot tile to be placed before spawning replay actors.
 */

import { system, world, StructureSaveMode } from "@minecraft/server";

const RADIUS = 31;
const REGION_SIZE = 62;
const TILE_SIZE = 31;

function deferredStructureId(replayId, index) {
    return `replay:snapshot_${replayId}_${index}`;
}

const snapshotState = {
    active: false,
    busy: false,
    replayId: undefined,
    structureIds: [],
    structureTiles: [],
    from: undefined,
    to: undefined,
    dimensionId: undefined,
    blocksSnapshotted: false,
    spawnSubscription: undefined,
    dieSubscription: undefined
};

function splitAxis(from, to) {
    const size = to - from + 1;
    if (size <= TILE_SIZE) return [{ from, to }];
    return [
        { from, to: from + TILE_SIZE - 1 },
        { from: from + TILE_SIZE, to }
    ];
}

function buildTiles(from, to, replayId) {
    const xs = splitAxis(from.x, to.x);
    const ys = splitAxis(from.y, to.y);
    const zs = splitAxis(from.z, to.z);
    const tiles = [];
    let index = 0;
    for (const x of xs) {
        for (const y of ys) {
            for (const z of zs) {
                tiles.push({
                    index,
                    id: deferredStructureId(replayId, index++),
                    from: { x: x.from, y: y.from, z: z.from },
                    to: { x: x.to, y: y.to, z: z.to }
                });
            }
        }
    }
    return tiles;
}

function cleanupStructureIds(ids) {
    for (const id of ids || []) {
        try { world.structureManager.delete(id); } catch (e) {}
    }
}

function isWithinBounds(loc, from, to) {
    return loc.x >= from.x && loc.x <= to.x &&
        loc.y >= from.y && loc.y <= to.y &&
        loc.z >= from.z && loc.z <= to.z;
}

/**
 * Captures the exact 62x62x62 region in watchdog-safe jobs.
 * @param {import("@minecraft/server").Player} director
 * @param {string} replayId
 * @returns {Promise<{ok:boolean, reason?:string, tiles?:number}>}
 */
export function beginSnapshot(director, replayId) {
    if (snapshotState.active || snapshotState.busy) {
        return Promise.resolve({ ok: false, reason: "already_active" });
    }

    snapshotState.busy = true;

    const center = director.location;
    // Exactly 62 blocks per axis: inclusive [from, from + 61].
    const from = {
        x: Math.floor(center.x) - RADIUS,
        y: Math.max(-64, Math.floor(center.y) - RADIUS),
        z: Math.floor(center.z) - RADIUS
    };
    const to = {
        x: from.x + REGION_SIZE - 1,
        y: Math.min(319, from.y + REGION_SIZE - 1),
        z: from.z + REGION_SIZE - 1
    };

    const tiles = buildTiles(from, to, replayId);

    return new Promise((resolve) => {
        const created = [];
        let finished = false;

        const finish = (result) => {
            if (finished) return;
            finished = true;
            snapshotState.busy = false;
            resolve(result);
        };

        try {
            cleanupStructureIds(tiles.map((t) => t.id));

            const job = system.runJob((function* () {
                try {
                    const dimension = director.dimension;
                    for (const tile of tiles) {
                        world.structureManager.createFromWorld(
                            tile.id,
                            dimension,
                            tile.from,
                            tile.to,
                            {
                                includeEntities: false,
                                saveMode: StructureSaveMode.World
                            }
                        );
                        created.push(tile.id);
                        // Yield after every structure creation. runJob was
                        // introduced before the project's @minecraft/server
                        // 2.2.0 target and is specifically intended for
                        // long-running work.
                        yield;
                    }

                    snapshotState.active = true;
                    snapshotState.replayId = replayId;
                    snapshotState.structureIds = created.slice();
                    snapshotState.structureTiles = tiles.map((tile) => ({ id: tile.id, from: { ...tile.from }, to: { ...tile.to } }));
                    snapshotState.from = { ...from };
                    snapshotState.to = { ...to };
                    snapshotState.dimensionId = dimension.id;
                    snapshotState.blocksSnapshotted = true;

                    finish({ ok: true, tiles: created.length });
                } catch (e) {
                    cleanupStructureIds(created);
                    finish({
                        ok: false,
                        reason: e && e.message ? String(e.message) : "snapshot_failed"
                    });
                }
            })());

            // Keep a reference only for diagnostics/possible future cancel.
            void job;
        } catch (e) {
            cleanupStructureIds(created);
            finish({
                ok: false,
                reason: e && e.message ? String(e.message) : "snapshot_failed"
            });
        }
    });
}

/**
 * Ends snapshot tracking and returns the deferred snapshot metadata.
 */
export function restoreSnapshot() {
    if (!snapshotState.active) {
        return { blocksRestored: false, entitiesRemoved: 0, entitiesRespawned: 0 };
    }

    const deferred = {
        structureIds: snapshotState.structureIds.slice(),
        structureTiles: snapshotState.structureTiles.map((tile) => ({ id: tile.id, from: { ...tile.from }, to: { ...tile.to } })),
        // Backward-compatible first structure id for old readers.
        structureId: snapshotState.structureIds[0],
        from: { ...snapshotState.from },
        to: { ...snapshotState.to },
        dimensionId: snapshotState.dimensionId,
        blocksSnapshotted: snapshotState.blocksSnapshotted
    };

    if (snapshotState.spawnSubscription) {
        try { world.afterEvents.entitySpawn.unsubscribe(snapshotState.spawnSubscription); } catch (e) {}
    }
    if (snapshotState.dieSubscription) {
        try { world.afterEvents.entityDie.unsubscribe(snapshotState.dieSubscription); } catch (e) {}
    }

    snapshotState.active = false;
    snapshotState.replayId = undefined;
    snapshotState.structureIds = [];
    snapshotState.structureTiles = [];
    snapshotState.from = undefined;
    snapshotState.to = undefined;
    snapshotState.dimensionId = undefined;
    snapshotState.blocksSnapshotted = false;
    snapshotState.spawnSubscription = undefined;
    snapshotState.dieSubscription = undefined;

    return {
        blocksRestored: false,
        entitiesRemoved: 0,
        entitiesRespawned: 0,
        deferred
    };
}

/**
 * Places every saved tile in a watchdog-safe runJob and resolves only after
 * all placement calls have been issued and a couple of ticks have elapsed,
 * giving queued structure placement in loaded chunks time to settle.
 *
 * @param {{structureIds?:string[], structureId?:string, from:object, to:object, dimensionId:string, blocksSnapshotted:boolean}} deferred
 * @returns {Promise<{blocksRestored:boolean, reason?:string}>}
 */
export function restoreDeferredSnapshot(deferred) {
    if (!deferred || !deferred.blocksSnapshotted) {
        return Promise.resolve({
            blocksRestored: false,
            reason: deferred
                ? "No block snapshot was captured when this replay was recorded."
                : "No deferred snapshot recorded for this replay."
        });
    }

    const tiles = Array.isArray(deferred.structureTiles) && deferred.structureTiles.length
        ? deferred.structureTiles
        : (Array.isArray(deferred.structureIds) && deferred.structureIds.length
            ? deferred.structureIds.map((id) => ({ id, from: { ...deferred.from } }))
            : (deferred.structureId ? [{ id: deferred.structureId, from: { ...deferred.from } }] : []));

    if (tiles.length === 0) {
        return Promise.resolve({ blocksRestored: false, reason: "Snapshot structure identifiers are missing." });
    }

    let dimension;
    try {
        dimension = world.getDimension(deferred.dimensionId);
    } catch (e) {
        return Promise.resolve({
            blocksRestored: false,
            reason: e && e.message ? String(e.message) : "dimension_unavailable"
        });
    }

    return new Promise((resolve) => {
        let finished = false;
        const finish = (result) => {
            if (finished) return;
            finished = true;
            resolve(result);
        };

        try {
            system.runJob((function* () {
                try {
                    for (const tile of tiles) {
                        // Full block placement, no entities and no integrity
                        // reduction. Each tile is placed back at its original
                        // capture coordinate.
                        world.structureManager.place(tile.id, dimension, tile.from, {
                            includeBlocks: true,
                            includeEntities: false,
                            integrity: 1
                        });
                        yield;
                    }

                    // Give queued placement work a couple of scheduler turns
                    // before actors are spawned.
                    yield;
                    yield;
                    finish({ blocksRestored: true });
                } catch (e) {
                    finish({
                        blocksRestored: false,
                        reason: e && e.message ? String(e.message) : "snapshot_restore_failed"
                    });
                }
            })());
        } catch (e) {
            finish({
                blocksRestored: false,
                reason: e && e.message ? String(e.message) : "snapshot_restore_failed"
            });
        }
    });
}

export function isSnapshotActive() {
    return snapshotState.active || snapshotState.busy;
}

export function deleteDeferredSnapshotStructure(structureOrIds) {
    const ids = Array.isArray(structureOrIds)
        ? structureOrIds
        : (structureOrIds ? [structureOrIds] : []);

    for (const id of ids) {
        try { world.structureManager.delete(id); } catch (e) {}
    }
}
