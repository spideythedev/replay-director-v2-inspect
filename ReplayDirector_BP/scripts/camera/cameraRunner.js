/**
 * Replay Director - Camera Runner
 *
 * The heart of the cinematic system. Given a "shot function" that maps
 * eased time t (0..1) to a {location, facingLocation} pair, this drives
 * the director's camera one tick at a time using @minecraft/server's
 * free camera, freezes the subject, runs an optional countdown first,
 * dips the FOV for a cinematic feel, hides the HUD, adds a subtle
 * handheld sway, and always hands control back smoothly at the end
 * (including on cancellation or player disconnect).
 *
 * playShot() runs a single shot. playSequence() chains several shots back
 * to back WITHOUT releasing the camera in between (no pop back to the
 * director's own view between segments) - used for multi-part cinematics
 * like Spawn Showcase (Orbit -> Bird's Eye -> Ground -> Hero).
 *
 * IMPORTANT: the camera must NOT be hard-cleared in the same tick as the
 * final free-camera frame - Bedrock's client can miss that clear() and
 * leave the view stuck on the last frame. We fix this by easing the
 * camera back to the director's own head/rotation first, waiting for
 * that ease to finish, and only then calling clear().
 */

import { system, world, EasingType, HudVisibility } from "@minecraft/server";
import { getEasingFn } from "../core/easing.js";
import { startNewRun, isRunCurrent, endRun, getSession, setSessionSubject } from "../core/state.js";
import { isCollisionEnabled, getPresetFov } from "../core/settings.js";
import { freezeTarget, unfreezeTarget } from "./freeze.js";
import { runCountdown } from "./countdown.js";
import { resolveCameraCollision } from "./collision.js";

// CINEMATIC_FOV was a hardcoded constant here (Global Preset FOV pass) -
// replaced by settings.getPresetFov() so there is exactly one FOV value
// used everywhere a preset camera runs (see dipFov() below).
const FOV_EASE_SECONDS = 0.3;
const RETURN_EASE_SECONDS = 0.5;
const RETURN_EASE_TICKS = Math.round(RETURN_EASE_SECONDS * 20);
const END_HOLD_SECONDS = 2;
const END_HOLD_TICKS = Math.round(END_HOLD_SECONDS * 20);
const PER_TICK_EASE_SECONDS = 0.09; // slightly longer than 1 tick (0.05s) so eases overlap and blend
const SWAY_AMPLITUDE = 0.035; // blocks - subtle handheld feel, not shaky

/**
 * @type {Set<string>} player ids whose HUD is currently hidden by this
 * add-on. Mirrors freeze.js's own `frozen` Set - added the same way, for
 * the same reason: cleanup() only restores the HUD if the director is
 * still isValid at that moment (see cleanup() below), so a director who
 * disconnects mid-cinematic (while the HUD is hidden) is left with no
 * code path that ever calls showHud() for them again. Tracking who's
 * hidden lets restoreHudOnRejoin() (called from main.js's playerSpawn
 * hook) detect and fix this on their next join, the same safety-net
 * pattern freeze.js's unfreezeTargetById() uses for input permissions.
 */
const hudHidden = new Set();

/**
 * @typedef {Object} ShotSegment
 * @property {number} durationTicks
 * @property {string} easing
 * @property {(t:number) => {location: {x:number,y:number,z:number}, facingLocation: {x:number,y:number,z:number}, fov?: number}} shotFn
 * @property {boolean} [sway] - defaults to true
 */

/**
 * @typedef {Object} ShotOptions
 * @property {number} durationTicks
 * @property {string} easing
 * @property {boolean} countdown
 * @property {boolean} freezeSubject
 * @property {import("@minecraft/server").Player} [subject]
 * @property {ShotSegment["shotFn"]} shotFn
 * @property {boolean} [sway]
 * @property {boolean} [disableCollision]
 * @property {() => void} [onComplete]
 */

/**
 * Runs a single cinematic shot.
 * @param {import("@minecraft/server").Player} director
 * @param {ShotOptions} options
 */
export async function playShot(director, options) {
    const segment = {
        durationTicks: options.durationTicks,
        easing: options.easing,
        shotFn: options.shotFn,
        sway: options.sway
    };
    return playSequence(director, {
        segments: [segment],
        countdown: options.countdown,
        freezeSubject: options.freezeSubject,
        subject: options.subject,
        disableCollision: options.disableCollision,
        onComplete: options.onComplete
    });
}

/**
 * @typedef {Object} SequenceOptions
 * @property {ShotSegment[]} segments - played back to back with no camera release between them
 * @property {boolean} countdown
 * @property {boolean} freezeSubject
 * @property {import("@minecraft/server").Player} [subject]
 * @property {boolean} [disableCollision]
 * @property {() => void} [onComplete]
 */

/**
 * Runs several shots in a row as one continuous cinematic - the camera is
 * never handed back to the director between segments, so it reads as a
 * single multi-part sequence instead of separate cuts.
 * @param {import("@minecraft/server").Player} director
 * @param {SequenceOptions} options
 */
export async function playSequence(director, options) {
    const { segments, countdown, freezeSubject, subject, disableCollision = false, onComplete } = options;

    const runId = startNewRun(director.id);
    setSessionSubject(director.id, subject);

    if (freezeSubject && subject) {
        freezeTarget(subject);
    }

    await runCountdown(director, countdown);

    // Bail out if the director cancelled / another shot started / left during countdown.
    if (!isRunCurrent(director.id, runId) || !director.isValid) {
        if (subject) unfreezeTarget(subject);
        return;
    }

    hideHud(director);
    dipFov(director);
    director.camera.fade({
        fadeColor: { red: 0, green: 0, blue: 0 },
        fadeTime: { fadeInTime: 0.35, holdTime: 0, fadeOutTime: 0.35 }
    });

    let completedCleanly = true;
    for (const segment of segments) {
        const finishedCleanly = await runSegmentTicks(director, runId, segment, subject, disableCollision);
        if (!finishedCleanly) {
            completedCleanly = false;
            break;
        }
    }

    // Editing tail: once a preset/manual camera sequence has genuinely
    // reached its final frame, hold that exact frame for two seconds before
    // handing control back to the player. This gives recordings a clean
    // tail without changing the authored shot duration.
    if (completedCleanly && segments.length > 0) {
        const finalSegment = segments[segments.length - 1];
        const finalFrame = finalSegment.shotFn(1);
        await holdFinalCameraFrame(director, runId, finalFrame, disableCollision);
    }

    await handBackToPlayerView(director);
    cleanup(director, subject);
    if (onComplete) onComplete();
}

/**
 * @typedef {Object} TimelineSegment
 * @property {number} startTick - absolute replay tick this segment begins at
 * @property {number} endTick - absolute replay tick this segment ends at
 * @property {string} easing
 * @property {(t:number) => {location:object, facingLocation:object, fov?:number}} shotFn
 * @property {boolean} [sway]
 */

/**
 * @typedef {Object} TimelineSequenceOptions
 * @property {TimelineSegment[]} segments - covering an absolute replay-tick range, back to back
 * @property {() => number} getTimelineTick - returns the replay's current (fractional) playhead tick, read fresh every camera frame
 * @property {() => boolean} isTimelineActive - returns whether the replay is still playing; the preview stops the instant this goes false, same as the replay itself stopping
 * @property {boolean} [disableCollision]
 * @property {() => void} [onComplete]
 * @property {Array<{timelineTick:number, armorSnapshot:object}>} [keyframeArmorPoints] - ascending by timelineTick, one entry per keyframe that has an armor snapshot. As the replay's live playhead crosses each point's timelineTick, that snapshot is applied live to the matching actors via applyArmorSnapshot - a wardrobe-change-on-arrival effect, independent of camera math. Optional so callers with no keyframe armor data (or none at all, e.g. "Play Camera Animation"'s separate non-timeline path) are unaffected.
 * @property {(snapshot:object) => void} [applyArmorSnapshot] - required alongside keyframeArmorPoints; applies one keyframe's {[actorPlayerId]: armor} snapshot live. Kept as an injected callback rather than importing actor/equipment code directly here, since cameraRunner.js is camera-only and shouldn't need to know about replay actors or equipment.
 */

/**
 * Preview Path's camera driver (Phase 3J). Unlike playSequence(), which
 * paces itself with its own elapsed-tick counter, this reads the replay's
 * live timeline position every camera frame and places the camera at
 * whichever point along the keyframe path corresponds to THAT tick - so
 * the camera is never "ahead" or "behind" the replay, it simply always
 * renders the path position for the replay's current moment, at whatever
 * speed (0.25x-4x) or pause state the replay is actually running at right
 * now. No local duration/elapsed counter exists here to drift out of sync.
 *
 * Deliberately separate from playSequence() rather than folded into it -
 * playSequence's countdown/elapsed-tick timing is exactly right for every
 * other caller (Presets, "Play Camera Animation") and is left untouched;
 * this function only adds a second, timeline-driven way to drive the same
 * per-tick camera primitives (setCamera/collision/sway/fov/hud), it does
 * not change how those primitives work.
 *
 * @param {import("@minecraft/server").Player} director
 * @param {TimelineSequenceOptions} options
 */
export async function playTimelineSequence(director, options) {
    const { segments, getTimelineTick, isTimelineActive, disableCollision = false, onComplete, keyframeArmorPoints = [], applyArmorSnapshot } = options;

    if (segments.length === 0) {
        if (onComplete) onComplete();
        return;
    }

    const runId = startNewRun(director.id);

    hideHud(director);
    dipFov(director);
    director.camera.fade({
        fadeColor: { red: 0, green: 0, blue: 0 },
        fadeTime: { fadeInTime: 0.35, holdTime: 0, fadeOutTime: 0.35 }
    });

    const rangeStart = segments[0].startTick;
    const rangeEnd = segments[segments.length - 1].endTick;

    // Armor-at-keyframe (Preview Path only): tracks the highest keyframe
    // index whose armorSnapshot has already been applied this run, so each
    // one fires exactly once as the live timeline tick crosses it - not
    // once per camera frame. Starts at -1 (nothing applied yet); if the
    // preview starts partway through the path (e.g. resuming), every
    // already-passed point up to the current tick is applied immediately
    // on the first frame below, same as a normal forward crossing would.
    let lastAppliedArmorIndex = -1;

    await new Promise((resolve) => {
        const tick = () => {
            if (!isRunCurrent(director.id, runId) || !director.isValid || !isTimelineActive()) {
                resolve();
                return;
            }

            const timelineTick = getTimelineTick();

            if (applyArmorSnapshot && keyframeArmorPoints.length > 0) {
                while (
                    lastAppliedArmorIndex + 1 < keyframeArmorPoints.length &&
                    keyframeArmorPoints[lastAppliedArmorIndex + 1].timelineTick <= timelineTick
                ) {
                    lastAppliedArmorIndex += 1;
                    applyArmorSnapshot(keyframeArmorPoints[lastAppliedArmorIndex].armorSnapshot);
                }
            }

            // Before the first keyframe's moment: hold on the first shot's
            // start pose rather than skipping ahead, so the camera is never
            // shown mid-path for a moment the replay hasn't reached yet.
            // After the last keyframe: hold the final pose - the path is
            // finished but the replay (and preview) may keep running.
            const clampedTick = Math.max(rangeStart, Math.min(rangeEnd, timelineTick));
            const segment = findSegmentForTick(segments, clampedTick);
            const easeFn = getEasingFn(segment.easing);
            const span = segment.endTick - segment.startTick || 1;
            const rawT = Math.max(0, Math.min(1, (clampedTick - segment.startTick) / span));
            const t = easeFn(rawT);

            try {
                const frame = segment.shotFn(t);
                let location = segment.sway ? applySway(frame.location, timelineTick) : frame.location;
                if (!disableCollision && isCollisionEnabled()) {
                    location = resolveCameraCollision(director.dimension, director.getHeadLocation(), location);
                }
                director.camera.setCamera("minecraft:free", {
                    location,
                    facingLocation: frame.facingLocation,
                    easeOptions: { easeTime: PER_TICK_EASE_SECONDS, easeType: EasingType.Linear }
                });
                // Global Preset FOV pass: settings.getPresetFov() via
                // dipFov() is the single source of truth for FOV on every
                // preset EXCEPT one - a preset whose fov IS the animated
                // effect (Dolly Zoom) marks its frame with animatedFov:true,
                // and only that flag keeps this per-tick apply alive. A
                // preset with a plain fixed frame.fov (no flag) is
                // deliberately ignored here, same as before.
                if (frame.animatedFov && frame.fov !== undefined) {
                    try {
                        director.camera.setFov({
                            fov: frame.fov,
                            easeOptions: { easeTime: PER_TICK_EASE_SECONDS, easeType: EasingType.Linear }
                        });
                    } catch (e) {
                        // fail soft - FOV module may not be available on this API version
                    }
                }
            } catch (e) {
                // If the world became invalid mid-shot, stop gracefully.
                resolve();
                return;
            }

            system.runTimeout(tick, 1);
        };

        tick();
    });

    if (isRunCurrent(director.id, runId) && director.isValid) {
        const finalSegment = segments[segments.length - 1];
        const finalFrame = finalSegment.shotFn(1);
        await holdFinalCameraFrame(director, runId, finalFrame, disableCollision);
    }

    await handBackToPlayerView(director);
    cleanup(director, undefined);
    if (onComplete) onComplete();
}

/** Finds the segment whose [startTick,endTick] range covers `tick` (segments are contiguous and ascending, so a linear scan is fine for the small keyframe counts this addon deals with). Falls back to the nearest end if `tick` sits exactly on a shared boundary or past the last segment. */
function findSegmentForTick(segments, tick) {
    for (const segment of segments) {
        if (tick <= segment.endTick) return segment;
    }
    return segments[segments.length - 1];
}

/**
 * Holds the final camera transform exactly in place for the editing tail.
 * No sway is applied during this period, so the recorded frame remains
 * visually stable. The hold is skipped automatically if the cinematic was
 * cancelled/replaced or the director left.
 */
function holdFinalCameraFrame(director, runId, frame, disableCollision = false) {
    return new Promise((resolve) => {
        let remaining = END_HOLD_TICKS;

        const tick = () => {
            if (!isRunCurrent(director.id, runId) || !director.isValid) {
                resolve(false);
                return;
            }

            try {
                let location = frame.location;
                if (!disableCollision && isCollisionEnabled()) {
                    location = resolveCameraCollision(
                        director.dimension,
                        director.getHeadLocation(),
                        location
                    );
                }

                director.camera.setCamera("minecraft:free", {
                    location,
                    facingLocation: frame.facingLocation,
                    easeOptions: {
                        easeTime: PER_TICK_EASE_SECONDS,
                        easeType: EasingType.Linear
                    }
                });

                if (frame.animatedFov && frame.fov !== undefined) {
                    try {
                        director.camera.setFov({
                            fov: frame.fov,
                            easeOptions: {
                                easeTime: PER_TICK_EASE_SECONDS,
                                easeType: EasingType.Linear
                            }
                        });
                    } catch (e) {
                        // fail soft
                    }
                }
            } catch (e) {
                resolve(false);
                return;
            }

            remaining--;
            if (remaining <= 0) {
                resolve(true);
                return;
            }

            system.runTimeout(tick, 1);
        };

        tick();
    });
}

/**
 * Drives one segment's tick loop. Resolves `true` if it played out to
 * completion, or `false` if it was interrupted (cancelled, director/subject
 * became invalid) - callers use that to stop a sequence early.
 */
function runSegmentTicks(director, runId, segment, subject, disableCollision) {
    const { durationTicks, easing, shotFn, sway = true } = segment;
    const easeFn = getEasingFn(easing);

    return new Promise((resolve) => {
        let elapsed = 0;

        const tick = () => {
            if (!isRunCurrent(director.id, runId) || !director.isValid) {
                resolve(false);
                return;
            }

            const rawT = Math.min(elapsed / durationTicks, 1);
            const t = easeFn(rawT);

            try {
                const frame = shotFn(t);
                let location = sway ? applySway(frame.location, elapsed) : frame.location;
                if (!disableCollision && subject && subject.isValid && isCollisionEnabled()) {
                    location = resolveCameraCollision(director.dimension, subject.getHeadLocation(), location);
                }
                director.camera.setCamera("minecraft:free", {
                    location,
                    facingLocation: frame.facingLocation,
                    easeOptions: { easeTime: PER_TICK_EASE_SECONDS, easeType: EasingType.Linear }
                });
                // Global Preset FOV pass: same animatedFov exception as
                // playTimelineSequence above - Dolly Zoom is the one preset
                // whose fov must keep animating per-tick; every other
                // preset's fov stays on the single global setting.
                if (frame.animatedFov && frame.fov !== undefined) {
                    try {
                        director.camera.setFov({
                            fov: frame.fov,
                            easeOptions: { easeTime: PER_TICK_EASE_SECONDS, easeType: EasingType.Linear }
                        });
                    } catch (e) {
                        // fail soft - FOV module may not be available on this API version
                    }
                }
            } catch (e) {
                // If the world/subject became invalid mid-shot, stop gracefully.
                resolve(false);
                return;
            }

            elapsed++;
            if (rawT >= 1) {
                resolve(true);
                return;
            }
            system.runTimeout(tick, 1);
        };

        tick();
    });
}

/**
 * Cancels whatever shot/sequence is currently running for this director,
 * restoring their normal camera and any frozen subject.
 * @param {import("@minecraft/server").Player} director
 */
/**
 * Handles a director disconnect without attempting camera APIs on an invalid
 * Player object. The client camera itself is lost with the disconnected
 * player; the important server-side cleanup is ending the cinematic run and
 * releasing any subject that was frozen for that director's shot.
 * @param {string} directorId
 */
export function handleDirectorDisconnect(directorId) {
    if (!directorId) return;
    const session = getSession(directorId);
    const subjectId = session.subject;
    endRun(directorId);

    if (subjectId) {
        const subject = world.getAllPlayers().find((player) => player.id === subjectId);
        if (subject && subject.isValid) {
            try {
                unfreezeTarget(subject);
            } catch (e) {
                // fail soft
            }
        }
    }
}

export async function cancelShot(director) {
    const session = getSession(director.id);
    const subject = session.subject;
    endRun(director.id);
    await handBackToPlayerView(director);
    cleanup(director, subject);
}

/** Smoothly eases the camera from wherever it is back into the director's own POV, then clears it. */
async function handBackToPlayerView(director) {
    if (!director.isValid) return;

    try {
        director.camera.setCamera("minecraft:free", {
            location: director.getHeadLocation(),
            rotation: director.getRotation(),
            easeOptions: { easeTime: RETURN_EASE_SECONDS, easeType: EasingType.OutCubic }
        });
    } catch (e) {
        // fail soft - fall through to clear() below regardless
    }

    await new Promise((resolve) => system.runTimeout(resolve, RETURN_EASE_TICKS));

    if (director.isValid) {
        try {
            director.camera.clear();
        } catch (e) {
            // fail soft
        }
    }
}

function cleanup(director, subject) {
    endRun(director.id);
    if (director.isValid) {
        restoreFov(director);
        showHud(director);
    }
    if (subject) unfreezeTarget(subject);
}

/**
 * Global Preset FOV: applies settings.getPresetFov() as the camera's FOV
 * for this shot. This is now the ONLY place FOV is set for any preset -
 * frame.fov overrides in the per-tick loops above were removed so this
 * single call is never overwritten a tick later by a preset's own value.
 */
function dipFov(director) {
    try {
        director.camera.setFov({
            fov: getPresetFov(),
            easeOptions: { easeTime: FOV_EASE_SECONDS, easeType: EasingType.OutCubic }
        });
    } catch (e) {
        // fail soft - FOV module may not be available on this API version
    }
}

function restoreFov(director) {
    try {
        director.runCommand(`camera @s fov_clear ${FOV_EASE_SECONDS} out_cubic`);
    } catch (e) {
        // fail soft
    }
}

function hideHud(director) {
    try {
        director.onScreenDisplay.setHudVisibility(HudVisibility.Hide);
        hudHidden.add(director.id);
    } catch (e) {
        // fail soft
    }
}

function showHud(director) {
    try {
        director.onScreenDisplay.setHudVisibility(HudVisibility.Reset);
        hudHidden.delete(director.id);
    } catch (e) {
        // fail soft
    }
}

/**
 * Safety net for a director who disconnected while their HUD was hidden
 * mid-cinematic (see the hudHidden Set's own doc comment above for why
 * cleanup() alone can't always catch this) - called from main.js's
 * playerSpawn rejoin hook with a fresh, valid Player object for whoever
 * just joined. No-ops for anyone not tracked as hidden, so this is safe
 * to call for every join, not just ones known to need it.
 * @param {import("@minecraft/server").Player} player - a currently-valid Player object for this id
 */
export function restoreHudOnRejoin(player) {
    if (!player || !player.isValid) return;
    if (!hudHidden.has(player.id)) return;
    try {
        player.onScreenDisplay.setHudVisibility(HudVisibility.Reset);
    } catch (e) {
        // fail soft
    }
    hudHidden.delete(player.id);
}

/** Tiny sinusoidal handheld sway so shots feel alive instead of robotic. */
function applySway(location, elapsedTicks) {
    const tSec = elapsedTicks / 20;
    return {
        x: location.x + Math.sin(tSec * 1.7) * SWAY_AMPLITUDE,
        y: location.y + Math.sin(tSec * 2.3 + 1.3) * SWAY_AMPLITUDE * 0.6,
        z: location.z + Math.cos(tSec * 1.9) * SWAY_AMPLITUDE
    };
}
