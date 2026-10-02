/**
 * Replay Director - Session State
 *
 * Tracks per-player cinematic session state in memory. This is intentionally
 * simple for Phase 1 (core foundation) - it does not persist across a world
 * reload, which is fine since a cinematic should never be "in progress"
 * across a save/load boundary.
 */

/** @type {Map<string, CinematicSession>} keyed by player.id */
const sessions = new Map();

/**
 * @typedef {Object} CinematicSession
 * @property {boolean} active
 * @property {number} runId - increments each run so stale intervals can bail out
 * @property {string|undefined} targetId - player.id of the cinematic subject
 * @property {boolean} targetWasFrozen
 * @property {import("@minecraft/server").GameMode|undefined} targetPrevGameMode
 */

export function getSession(playerId) {
    let session = sessions.get(playerId);
    if (!session) {
        session = {
            active: false,
            runId: 0,
            targetId: undefined,
            targetWasFrozen: false,
            subject: undefined
        };
        sessions.set(playerId, session);
    }
    return session;
}

export function setSessionSubject(playerId, subject) {
    const session = getSession(playerId);
    session.subject = subject;
}

export function startNewRun(playerId) {
    const session = getSession(playerId);
    session.active = true;
    session.runId += 1;
    return session.runId;
}

export function isRunCurrent(playerId, runId) {
    const session = sessions.get(playerId);
    return !!session && session.active && session.runId === runId;
}

export function endRun(playerId) {
    const session = sessions.get(playerId);
    if (session) {
        session.active = false;
        session.targetId = undefined;
        session.subject = undefined;
    }
}

export function clearSession(playerId) {
    sessions.delete(playerId);
}
