/**
 * Replay Director - Core Constants
 * Phase 1: Core Foundation
 */

export const DEFAULT_DURATION_TICKS = 100; // 5 seconds at 20 tps
export const COUNTDOWN_ENABLED_DEFAULT = true;

export const EASING = {
    LINEAR: "linear",
    EASE_IN: "ease_in",
    EASE_OUT: "ease_out",
    EASE_IN_OUT: "ease_in_out"
};

// Scoreboard/dynamic-property keys used to persist small per-player settings
export const PROP_COUNTDOWN = "replay:countdown_enabled";
