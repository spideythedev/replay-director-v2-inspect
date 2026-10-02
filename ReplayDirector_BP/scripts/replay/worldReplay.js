/**
 * Replay Director - World Replay (world interaction recreation)
 *
 * Standalone module, additive alongside eventPlayback.js (which still owns
 * the arm-swing pulse for block_place/block_break - that's untouched).
 * This module owns exactly one thing: actually setting/removing real
 * blocks in the world so recorded terrain/block-state changes play back at
 * the exact recorded moment.
 *
 * Reversibility during a LIVE session is why this isn't just "replay
 * events forward and ignore the rest": Timeline supports pause/seek/
 * restart in both directions while a replay is actively playing, so a
 * jump backward has to be able to undo block changes that were already
 * applied, not just stop applying new ones. Every event type this module
 * handles carries both a beforePermutation and an afterPermutation
 * snapshot (see events.js) - moving the cursor forward applies
 * afterPermutation, moving it backward re-applies beforePermutation. A
 * single monotonically-adjustable cursor (like actors' frame cursor, but
 * over the block-event list instead of position frames) makes both
 * directions cheap during a live seek: only the events strictly between
 * the old and new cursor position are ever touched, never a full-region
 * replay.
 *
 * This reversibility is ONLY for seeking within an active playback
 * session - endWorldReplay() (called when playback stops or naturally
 * ends) does NOT undo anything. Whatever the replay's actors placed/
 * broke/changed during playback stays in the world permanently after
 * playback ends, matching the project-wide rule that world state only
 * ever resets at replay START (via snapshot.js's restoreDeferredSnapshot,
 * see playback.js), never at stop/end.
 *
 * Scope (World Interaction Replay pass): originally only block_place/
 * block_break. Now also handles block_interact (ANY block a player
 * right-clicks that actually changes state - e.g. Respawn Anchor charging
 * - captured generically in events.js, not hardcoded per block type here
 * either) and block_explode (ANY explosion-destroyed block - e.g. Respawn
 * Anchor explosion, End Crystal explosion, TNT, etc, again handled
 * generically). All four event types share the exact same apply-forward/
 * apply-backward/setBlock machinery below, since "restore this block's
 * permutation to a captured snapshot" is the same operation regardless of
 * which kind of interaction produced the snapshot - there is deliberately
 * no per-event-type branching in the block-mutation logic itself, only in
 * which events get included in state.events (see the filter in
 * beginWorldReplay). Everything else eventPlayback.js already does (mob
 * spawn/death, damage, item use) is untouched and unrelated to this task.
 *
 * NOT HANDLED (confirmed API gap, not something guessed around): the
 * vanilla block-breaking crack/progress overlay (the cracking texture that
 * grows over a block while it's being mined) has no stable Script API
 * equivalent to drive or reproduce - there is no confirmed stable "set
 * block destroy progress" function, and no confirmed stable particle
 * identifier for the vanilla crack-texture dust either (the commonly cited
 * "block crack" particle APIs belong to Java/Bukkit, not Bedrock's Script
 * API). block_break already fires (and is replayed here) at the moment the
 * block finishes breaking - what's missing is only the incremental
 * cracking animation during the mining that precedes it, and there's
 * currently no real capturable data or stable playback primitive for that.
 * Faking it with a made-up particle or a guessed API call would violate
 * the "don't fake events during playback" requirement, so this stays
 * undone until a real primitive exists for it.
 */

import { BlockPermutation } from "@minecraft/server";
import { getEventData } from "./storage.js";

const WORLD_MUTATING_EVENT_TYPES = new Set(["block_place", "block_break", "block_interact", "block_explode"]);


function locationKey(location) {
    if (!location || typeof location.x !== "number" || typeof location.y !== "number" || typeof location.z !== "number") return undefined;
    return `${Math.floor(location.x)},${Math.floor(location.y)},${Math.floor(location.z)}`;
}

function snapshotPermutation(permutation) {
    if (!permutation) return undefined;
    try {
        return { typeId: permutation.type.id, states: permutation.getAllStates() };
    } catch (e) {
        try { return { typeId: permutation.type.id, states: {} }; } catch (e2) { return undefined; }
    }
}

function clonePermutationSnapshot(snapshot) {
    if (!snapshot || !snapshot.typeId) return undefined;
    return { typeId: snapshot.typeId, states: snapshot.states ? { ...snapshot.states } : {} };
}

const state = {
    active: false,
    dimension: undefined,
    /** @type {Array<object>} block_place/block_break/block_interact/block_explode events only, sorted by tick */
    events: [],
    /** Index of the last event that has been applied (forward). -1 means none applied yet. */
    cursor: -1,
    /** @type {Map<string, object|undefined>} baseline block permutations captured after snapshot restore */
    baselinePermutations: new Map()
};

/**
 * @param {string} replayId
 * @param {import("@minecraft/server").Dimension} dimension
 */
export function beginWorldReplay(replayId, dimension) {
    const all = getEventData(replayId) || [];
    state.active = true;
    state.dimension = dimension;
    state.events = all
        .filter((e) => WORLD_MUTATING_EVENT_TYPES.has(e.type))
        .filter((e) => !e.data?.dimensionId || e.data.dimensionId === dimension.id)
        .slice()
        .sort((a, b) => a.tick - b.tick);
    state.cursor = -1;
    state.baselinePermutations = new Map();

    // Replay startup has already restored the recorded pre-recording snapshot
    // before this function is called. Capture the baseline only at locations
    // that actually participate in block replay; this is tiny compared with
    // scanning the whole 62x62x62 snapshot.
    for (const event of state.events) {
        const location = event?.data?.location;
        if (!location) continue;
        const key = locationKey(location);
        if (state.baselinePermutations.has(key)) continue;
        try {
            const block = dimension.getBlock(location);
            state.baselinePermutations.set(key, block ? snapshotPermutation(block.permutation) : undefined);
        } catch (e) {
            state.baselinePermutations.set(key, undefined);
        }
    }

    // Normalize missing before-states using the restored baseline and the
    // already-recorded event history. This removes the old "block_place =
    // air" assumption without requiring a risky before-place API.
    const virtualState = new Map(state.baselinePermutations);
    for (const event of state.events) {
        const key = locationKey(event?.data?.location);
        if (!key) continue;
        if (!event.data.beforePermutation) {
            event.data.beforePermutation = clonePermutationSnapshot(virtualState.get(key));
        }
        if (event.data.afterPermutation) {
            virtualState.set(key, clonePermutationSnapshot(event.data.afterPermutation));
        } else if (event.type === "block_break" || event.type === "block_explode") {
            virtualState.set(key, { typeId: "minecraft:air", states: {} });
        }
    }
}

/**
 * Applies every not-yet-applied event at or before currentTick, in order.
 * Called from playback.js's whole-tick bookkeeping - forward-only during
 * normal playback, same pattern as tickEventPlayback.
 * @param {number} currentTick
 */
export function tickWorldReplay(currentTick) {
    if (!state.active) return;

    while (state.cursor + 1 < state.events.length && state.events[state.cursor + 1].tick <= currentTick) {
        applyForward(state.events[state.cursor + 1]);
        state.cursor++;
    }
}

/**
 * Jumps the block-replay cursor to match an arbitrary target tick (forward
 * or backward), applying/undoing exactly the events in between.
 * @param {number} targetTick
 */
export function seekWorldReplay(targetTick) {
    if (!state.active) return;

    const targetCursor = lastIndexAtOrBefore(targetTick);

    if (targetCursor > state.cursor) {
        for (let i = state.cursor + 1; i <= targetCursor; i++) {
            applyForward(state.events[i]);
        }
        state.cursor = targetCursor;
    } else if (targetCursor < state.cursor) {
        for (let i = state.cursor; i > targetCursor; i--) {
            applyBackward(state.events[i]);
        }
        state.cursor = targetCursor;
    }
}

/**
 * Ends World Replay tracking for this playback session WITHOUT undoing
 * any block changes - whatever the replay's actors placed/broke/changed
 * during playback stays exactly as it is, permanently, matching the same
 * "world state only ever resets at replay START, never at stop/end"
 * principle the snapshot-restore system (snapshot.js/playback.js) already
 * follows. A prior version of this function rewound every applied block
 * change back to its pre-playback state on every stop (manual or
 * natural) - that was the actual, confirmed cause of "world reverts the
 * instant a replay stops/completes," a completely separate mechanism
 * from the snapshot-restore system this had been mistaken for across
 * several earlier fix attempts. Called on stop and on natural
 * end-of-replay, same call sites as before - only the behavior at those
 * call sites changed, not when this function runs.
 */
export function endWorldReplay() {
    resetState();
}

function resetState() {
    state.active = false;
    state.dimension = undefined;
    state.events = [];
    state.cursor = -1;
    state.baselinePermutations = new Map();
}

/** @returns {number} index of the last event whose tick <= targetTick, or -1 if none */
function lastIndexAtOrBefore(targetTick) {
    let lo = 0;
    let hi = state.events.length - 1;
    let result = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (state.events[mid].tick <= targetTick) {
            result = mid;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    return result;
}

function applyForward(event) {
    setBlock(event.data.location, event.data.afterPermutation, fallbackAfter(event));
}

function applyBackward(event) {
    setBlock(event.data.location, event.data.beforePermutation, fallbackBefore(event));
}

/**
 * Fallback for replays saved before permutation snapshots existed, or the
 * rare capture miss - keeps old saved replays functional (just without
 * exact block states).
 *
 * - block_break/block_explode destroy the block, so "after" without a
 *   snapshot falls back to air (the honest assumption when we don't know
 *   what state it left behind).
 * - block_place's "after" is the placed block's own typeId - always
 *   captured directly from the placement event itself, not a guess.
 * - block_interact never changes the block's typeId (only its internal
 *   states, e.g. a Respawn Anchor's charge count) - so without a snapshot,
 *   falling back to the block's own recorded typeId is the correct no-op-
 *   shaped default, not air (which would wrongly delete the block).
 */
function fallbackAfter(event) {
    if (event.type === "block_break" || event.type === "block_explode") return "minecraft:air";
    return event.data.blockTypeId || "minecraft:air";
}

/**
 * - block_place's "before" is empty space by definition (see file header -
 *   no beforeEvents.playerPlaceBlock exists to capture the true pre-state,
 *   and air is correct for the overwhelming majority of placements).
 * - block_break/block_explode/block_interact all have a real captured
 *   beforePermutation in the normal case (this fallback only triggers for
 *   old saved replays or a rare capture miss) - falling back to the
 *   event's own recorded blockTypeId is the closest honest guess for those,
 *   since it's what the block actually was typeId-wise before the event.
 */
function fallbackBefore(event) {
    // A missing beforePermutation is resolved from the pre-recording world
    // baseline captured in beginWorldReplay(), then from earlier event state.
    // This is especially important for block_place: a placement can replace
    // a real block, so blindly assuming air can corrupt the rewind state.
    if (event?.data?.beforePermutation) return event.data.beforePermutation;
    const key = locationKey(event?.data?.location);
    if (key && state.baselinePermutations.has(key)) {
        return state.baselinePermutations.get(key);
    }
    return event.data.blockTypeId || "minecraft:air";
}

function setBlock(location, snapshot, fallbackTypeId) {
    if (!state.dimension) return;
    try {
        const block = state.dimension.getBlock(location);
        if (!block) return;
        const permutation = resolvePermutation(snapshot, fallbackTypeId);
        if (permutation) block.setPermutation(permutation);
    } catch (e) {
        // fail soft - unloaded chunk or an otherwise-unresolvable block
        // shouldn't stop the rest of the replay.
    }
}

function resolvePermutation(snapshot, fallbackTypeId) {
    if (snapshot && snapshot.typeId) {
        try {
            return BlockPermutation.resolve(snapshot.typeId, snapshot.states || {});
        } catch (e) {
            try {
                return BlockPermutation.resolve(snapshot.typeId);
            } catch (e2) {
                // fall through to fallbackTypeId below
            }
        }
    }
    try {
        return BlockPermutation.resolve(fallbackTypeId || "minecraft:air");
    } catch (e) {
        return undefined;
    }
}
