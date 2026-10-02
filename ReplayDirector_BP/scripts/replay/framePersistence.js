/**
 * Replay Director - Frame Data Persistence (Persistent Recordings pass)
 *
 * Everything in storage.js's frameStore/equipmentFrameStore/mobFrameStore/
 * mobEquipmentFrameStore/eventStore is - and remains - in-memory only
 * (plain JS Maps, gone on world restart). This file adds a SEPARATE,
 * additive persistence layer on top: when a recording finishes, its full
 * frame/equipment/event bundle is also serialized and written to real
 * world dynamic properties, chunked across many keys, so it survives a
 * server/world restart. Reading it back reconstructs the exact same Map
 * shapes storage.js already expects, so playback.js needs no changes -
 * it keeps asking storage.js's getFrameData()/getEquipmentFrameData()/etc,
 * and storage.js is the one place that now also checks this persistence
 * layer when the in-memory Maps come up empty (e.g. after a restart).
 *
 * WHY CHUNKED, NOT ONE KEY (confirmed limit, not a guess):
 * a single string dynamic property has a hard 32,767-byte limit
 * (confirmed via Microsoft's own Script API docs and the Bedrock Wiki's
 * Script Core Features page) - a single recording's combined frame data
 * across all actors/mobs/equipment/events routinely exceeds that for
 * anything beyond a few seconds, so the serialized JSON is split into
 * fixed-size string chunks, each written under its own key
 * (replay:frames:<replayId>:<chunkIndex>), with a small header key
 * recording how many chunks exist and the total serialized length (for
 * validation on read-back).
 *
 * WHY ONLY NEW RECORDINGS (explicit, deliberate scope, not a limitation
 * this file works around): per the user's own explicit choice, this only
 * ever writes at the moment a NEW recording is saved (see
 * persistFrameData(), called from storage.js's saveReplayFromRecording).
 * Replays that were already sitting in the in-memory-only stores before
 * this feature existed are NOT retroactively persisted - they remain
 * exactly as fragile as before (gone on the next restart), by design.
 *
 * WORLD-WIDE BUDGET: there is no hard-documented world-total dynamic
 * property cap the way there is a 32,767-byte per-key cap (Mojang's own
 * 2023 Scripting Q&A confirms they deliberately removed such a
 * restriction), but writing unboundedly is still a real risk to world
 * save file size/load performance. PERSIST_BYTE_BUDGET below is a
 * conservative, self-imposed ceiling checked via
 * world.getDynamicPropertyTotalByteCount() before every write - if
 * persisting a new recording would push the total over budget,
 * persistence is skipped for that recording (it still saves normally to
 * the in-memory store and plays fine THIS session, it just won't survive
 * a restart) rather than ever silently corrupting or truncating another
 * replay's already-persisted data.
 */

import { world, system } from "@minecraft/server";
import { rdLog, rdWarn, rdError } from "../core/debugLog.js";

/** Hard engine limit per string dynamic property; keep this value fixed. */
const MAX_PROPERTY_BYTES = 32767;

/** Safety margin under the hard limit - leaves room for the key name itself and any UTF-8 multi-byte character landing right at a chunk boundary (chunking splits by JS string index, not by byte, so a surrogate pair split across two chunks needs to never happen - see chunkString). */
const CHUNK_SIZE = 30000;

/**
 * Self-imposed ceiling on persisted Replay data. This is intentionally kept
 * at 100 MB. It is not a Minecraft world-total hard limit; it is Replay
 * Director's own safety budget. Actual dynamic-property usage is checked
 * with world.getDynamicPropertyTotalByteCount(), which includes both keys
 * and values, before anything is written.
 */
const PERSIST_BYTE_BUDGET = 100 * 1024 * 1024; // 100 MB

const KEY_PREFIX = "replay:frames:";

function headerKey(replayId) {
    return `${KEY_PREFIX}${replayId}:header`;
}

function chunkKey(replayId, index) {
    return `${KEY_PREFIX}${replayId}:${index}`;
}

/**
 * Split by UTF-8 byte size rather than JavaScript UTF-16 character count.
 * Dynamic-property string limits are byte-based. Iterating with `for...of`
 * keeps Unicode code points intact, including surrogate-pair characters.
 */
function chunkString(str) {
    const chunks = [];
    let chunk = "";
    let bytes = 0;

    for (const char of str) {
        const charBytes = utf8ByteLength(char);
        if (chunk && bytes + charBytes > CHUNK_SIZE) {
            chunks.push(chunk);
            chunk = "";
            bytes = 0;
        }
        chunk += char;
        bytes += charBytes;
    }
    if (chunk) chunks.push(chunk);
    return chunks;
}

/**
 * Serializes a replay's full frame/equipment/event bundle and writes it
 * across chunked dynamic properties. Called once, right after a recording
 * is saved (see storage.js's saveReplayFromRecording) - never called
 * again for that replay afterward (persistence is write-once per
 * recording, matching the "only new recordings" scope).
 * @param {string} replayId
 * @param {object} bundle - {buffer, equipmentBuffer, mobBuffer, mobEquipmentBuffer, events} - Maps are converted to plain objects internally before serializing
 * @returns {{ok:boolean, reason?:string, bytes?:number}}
 */
export function persistFrameData(replayId, bundle) {
    return new Promise((resolve) => {
        try {
            const plain = {
                buffer: mapToObject(bundle.buffer),
                equipmentBuffer: mapToObject(bundle.equipmentBuffer),
                mobBuffer: mapToObject(bundle.mobBuffer),
                mobEquipmentBuffer: mapToObject(bundle.mobEquipmentBuffer),
                mobStatusBuffer: mapToObject(bundle.mobStatusBuffer),
                events: bundle.events || []
            };

            const json = JSON.stringify(plain);
            const bytes = utf8ByteLength(json);
            const chunks = chunkString(json);
            const headerValue = JSON.stringify({ chunkCount: chunks.length, totalLength: json.length });
            const header = headerKey(replayId);

            // Count the real key + value footprint of every property we are
            // about to create. The World API's byte counter includes both,
            // so the preflight must do the same. This prevents the old
            // JSON-bytes-only check from overshooting the 100 MB budget.
            let projectedBytes = utf8ByteLength(header) + utf8ByteLength(headerValue);
            for (let i = 0; i < chunks.length; i++) {
                projectedBytes += utf8ByteLength(chunkKey(replayId, i)) + utf8ByteLength(chunks[i]);
            }

            const currentTotal = world.getDynamicPropertyTotalByteCount();
            if (currentTotal + projectedBytes > PERSIST_BYTE_BUDGET) {
                rdWarn(
                    `persistFrameData: skipping persistence for replay ${replayId} - would exceed the 100 MB budget (current total=${currentTotal}, projected add=${projectedBytes}). It still plays normally this session from memory.`
                );
                resolve({ ok: false, reason: "budget_exceeded", bytes });
                return;
            }

            // Spread writes over multiple ticks so a large 100 MB recording
            // cannot monopolize one script tick and trip the watchdog.
            // The header is written last, so an incomplete write cannot be
            // mistaken for a valid persisted replay.
            system.runJob((function* () {
                const writtenKeys = [];
                try {
                    for (let i = 0; i < chunks.length; i++) {
                        const key = chunkKey(replayId, i);
                        world.setDynamicProperty(key, chunks[i]);
                        writtenKeys.push(key);
                        yield;
                    }

                    world.setDynamicProperty(header, headerValue);
                    writtenKeys.push(header);
                    rdLog(`persistFrameData: replay ${replayId} persisted OK - ${chunks.length} chunk(s), ${bytes} JSON bytes, ${projectedBytes} dynamic-property bytes.`);
                    resolve({ ok: true, bytes, persistedBytes: projectedBytes });
                } catch (e) {
                    // Roll back every property written by this attempt.
                    for (const key of writtenKeys) {
                        try { world.setDynamicProperty(key, undefined); } catch (ignore) {}
                    }
                    rdError(`persistFrameData: failed while writing replay ${replayId}; partial data was rolled back.`, e);
                    resolve({ ok: false, reason: e && e.message ? String(e.message) : "persistence_write_failed", bytes });
                }
            })());
        } catch (e) {
            rdError(`persistFrameData: THREW before writing replay ${replayId} - recording remains available in memory for this session.`, e);
            resolve({ ok: false, reason: e && e.message ? String(e.message) : "unknown error" });
        }
    });
}

/**
 * Reads back a persisted replay's frame/equipment/event bundle, if one
 * exists - returns undefined if this replay was never persisted (e.g. it
 * predates this feature, or persistFrameData() skipped it due to budget).
 * storage.js calls this as a fallback exactly once, the first time a
 * replay's in-memory Maps come up empty for a given id - see that file's
 * getFrameData() family for the actual fallback wiring.
 * @param {string} replayId
 * @returns {{buffer:Map, equipmentBuffer:Map, mobBuffer:Map, mobEquipmentBuffer:Map, events:Array}|undefined}
 */
export function loadPersistedFrameData(replayId) {
    try {
        const headerRaw = world.getDynamicProperty(headerKey(replayId));
        if (typeof headerRaw !== "string") return undefined;

        const header = JSON.parse(headerRaw);
        if (!header || typeof header.chunkCount !== "number") return undefined;

        let json = "";
        for (let i = 0; i < header.chunkCount; i++) {
            const chunk = world.getDynamicProperty(chunkKey(replayId, i));
            if (typeof chunk !== "string") {
                rdError(`loadPersistedFrameData: replay ${replayId} is missing chunk ${i} of ${header.chunkCount} - persisted data is incomplete, treating as unavailable.`);
                return undefined;
            }
            json += chunk;
        }

        if (typeof header.totalLength === "number" && json.length !== header.totalLength) {
            rdError(`loadPersistedFrameData: replay ${replayId} reassembled length (${json.length}) doesn't match header (${header.totalLength}) - data may be corrupt, treating as unavailable.`);
            return undefined;
        }

        const plain = JSON.parse(json);

        rdLog(`loadPersistedFrameData: replay ${replayId} loaded OK from ${header.chunkCount} chunk(s).`);

        return {
            buffer: objectToMap(plain.buffer),
            equipmentBuffer: objectToMap(plain.equipmentBuffer),
            mobBuffer: objectToMap(plain.mobBuffer),
            mobEquipmentBuffer: objectToMap(plain.mobEquipmentBuffer),
            mobStatusBuffer: objectToMap(plain.mobStatusBuffer),
            events: plain.events || []
        };
    } catch (e) {
        rdError(`loadPersistedFrameData: THREW for replay ${replayId} - treating as unavailable.`, e);
        return undefined;
    }
}

/**
 * Deletes every dynamic property key belonging to a replay's persisted
 * frame data - called from storage.js's deleteReplay() so a deleted
 * replay doesn't leave orphaned chunks behind forever consuming budget.
 * Safe to call even if the replay was never persisted (no-op per key).
 * @param {string} replayId
 */
export function deletePersistedFrameData(replayId) {
    try {
        const headerRaw = world.getDynamicProperty(headerKey(replayId));
        if (typeof headerRaw !== "string") return;

        const header = JSON.parse(headerRaw);
        const chunkCount = header && typeof header.chunkCount === "number" ? header.chunkCount : 0;

        for (let i = 0; i < chunkCount; i++) {
            world.setDynamicProperty(chunkKey(replayId, i), undefined);
        }
        world.setDynamicProperty(headerKey(replayId), undefined);
    } catch (e) {
        // fail soft - a replay whose header is unreadable has nothing
        // reliably cleanable anyway; not worth blocking the delete over
    }
}

/** @returns {boolean} whether this replay has persisted frame data available to load */
export function hasPersistedFrameData(replayId) {
    try {
        return typeof world.getDynamicProperty(headerKey(replayId)) === "string";
    } catch (e) {
        return false;
    }
}

function mapToObject(map) {
    const obj = {};
    if (!map) return obj;
    for (const [key, value] of map.entries()) {
        obj[key] = value;
    }
    return obj;
}

function objectToMap(obj) {
    const map = new Map();
    if (!obj) return map;
    for (const key of Object.keys(obj)) {
        map.set(key, obj[key]);
    }
    return map;
}

/**
 * Returns the actual UTF-8 byte count for a string. For serialized JSON,
 * this is the correct unit for the dynamic-property string limit and for
 * the 100 MB storage budget.
 */
function utf8ByteLength(str) {
    let bytes = 0;
    for (const char of String(str)) {
        const code = char.codePointAt(0);
        if (code <= 0x7f) bytes += 1;
        else if (code <= 0x7ff) bytes += 2;
        else if (code <= 0xffff) bytes += 3;
        else bytes += 4;
    }
    return bytes;
}
