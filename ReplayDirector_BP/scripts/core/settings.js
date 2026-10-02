/**
 * Replay Director - Settings
 *
 * Small persisted world settings (survive world reload) backed by
 * dynamic properties. Kept deliberately tiny for Phase 2 - the full
 * Settings section (HUD toggles, hide-replay-entity, etc.) grows here
 * in later phases without touching callers.
 */

import { world } from "@minecraft/server";

const KEY_COUNTDOWN = "replay:countdown_enabled";
const KEY_COLLISION = "replay:collision_enabled";
const KEY_KEEP_TOUCH_CONTROLS = "replay:keep_touch_controls";
const KEY_PRESET_FOV = "replay:preset_fov";

const DEFAULT_PRESET_FOV = 30;
const MIN_PRESET_FOV = 30;
const MAX_PRESET_FOV = 70;

export function isCountdownEnabled() {
    const v = world.getDynamicProperty(KEY_COUNTDOWN);
    return v === undefined ? true : !!v;
}

export function setCountdownEnabled(value) {
    world.setDynamicProperty(KEY_COUNTDOWN, !!value);
}

export function isCollisionEnabled() {
    const v = world.getDynamicProperty(KEY_COLLISION);
    return v === undefined ? true : !!v;
}

export function setCollisionEnabled(value) {
    world.setDynamicProperty(KEY_COLLISION, !!value);
}

/**
 * Mobile Touch Compatibility pass: OFF by default (matches existing
 * behavior exactly - freeze.js's InputPermissionCategory.Movement/Camera/
 * LateralMovement disabling during a cinematic, unchanged for anyone who
 * doesn't touch this setting). ON lets touch users keep their joystick/
 * jump/attack controls usable while a cinematic (camera preset or Manual
 * Camera playback) is running - freeze.js checks this and skips disabling
 * those categories entirely when it's on, rather than disabling and
 * immediately re-enabling (which would still cause the same visible
 * flicker/unresponsiveness this setting exists to avoid).
 */
export function isKeepTouchControlsEnabled() {
    const v = world.getDynamicProperty(KEY_KEEP_TOUCH_CONTROLS);
    return v === undefined ? false : !!v;
}

export function setKeepTouchControlsEnabled(value) {
    world.setDynamicProperty(KEY_KEEP_TOUCH_CONTROLS, !!value);
}

/**
 * Global Preset FOV (QoL pass): a single world setting that replaces the
 * old hardcoded CINEMATIC_FOV constant in cameraRunner.js. Deliberately
 * the ONE source of truth for FOV everywhere a preset camera runs -
 * cameraRunner.js applies this value unconditionally in dipFov(), even on
 * frames that carry their own frame.fov (Action Follow/Chase/Close Action
 * previously hardcoded wider per-frame FOVs; this setting now overrides
 * those too, by design, so changing it once really does affect the whole
 * addon with no silent exceptions).
 */
export function getPresetFov() {
    const v = world.getDynamicProperty(KEY_PRESET_FOV);
    return v === undefined ? DEFAULT_PRESET_FOV : v;
}

/** Clamped to [20, 70] so a bad value (e.g. from a future direct dynamic-property edit) can't produce a degenerate camera FOV. */
export function setPresetFov(value) {
    const clamped = Math.max(MIN_PRESET_FOV, Math.min(MAX_PRESET_FOV, Math.round(value)));
    world.setDynamicProperty(KEY_PRESET_FOV, clamped);
}

export { MIN_PRESET_FOV, MAX_PRESET_FOV, DEFAULT_PRESET_FOV };
