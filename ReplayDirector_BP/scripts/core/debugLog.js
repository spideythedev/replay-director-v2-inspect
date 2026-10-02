/**
 * Replay Director - Debug Logger (Equipment Pipeline Investigation)
 *
 * Dedicated logger that writes to BOTH Minecraft chat (world.sendMessage)
 * and the Content Log (console.warn - the Bedrock script engine only
 * surfaces console.warn/console.error in the Content Log panel;
 * console.log/console.info do NOT reliably appear there, which is the
 * likely reason "no useful Content Log errors appear" even where the
 * addon already had try/catch - those catches never called anything at
 * all, silent or otherwise, and any prior console.log calls elsewhere in
 * the addon would not have shown up in Content Log either).
 *
 * Toggle with: /scriptevent replay:debug on   and   /scriptevent replay:debug off
 * State is NOT persisted - resets to off on world reload, by design,
 * so a debug session can never be accidentally left spamming a real
 * playback.
 */

import { world } from "@minecraft/server";

let debugEnabled = false;

export function isReplayDebugEnabled() {
    return debugEnabled;
}

export function setReplayDebugEnabled(value) {
    debugEnabled = !!value;
    const msg = debugEnabled
        ? "§a[Replay Debug] Enabled - equipment pipeline logging is ON."
        : "§7[Replay Debug] Disabled.";
    try { world.sendMessage(msg); } catch (e) { /* no players online yet */ }
    console.warn(`[ReplayDirector] Debug mode ${debugEnabled ? "ENABLED" : "DISABLED"}`);
}

/**
 * Core dual-sink log function. Always writes to Content Log via
 * console.warn (visible regardless of debug toggle state is NOT the
 * behavior here - respects the toggle, see rdLog/rdError below).
 */
function writeBoth(prefix, message) {
    const line = `${prefix} ${message}`;
    try { world.sendMessage(line); } catch (e) { /* no players online */ }
    console.warn(line);
}

/** Normal debug-mode-only log line. No-op if debug mode is off. */
export function rdLog(message) {
    if (!debugEnabled) return;
    writeBoth("§b[RD-DEBUG]§r", message);
}

/**
 * Error log line - ALWAYS prints regardless of debug toggle (errors must
 * never be silently swallowed), plus the full stack trace to Content Log
 * only (stack traces are too noisy for chat).
 */
export function rdError(message, err) {
    writeBoth("§c[RD-ERROR]§r", message);
    if (err) {
        const stack = (err && err.stack) ? err.stack : String(err);
        console.warn(`[ReplayDirector][STACK] ${stack}`);
    }
}

/** Warn line - always prints regardless of toggle (unexpected-but-not-fatal states). */
export function rdWarn(message) {
    writeBoth("§e[RD-WARN]§r", message);
}
