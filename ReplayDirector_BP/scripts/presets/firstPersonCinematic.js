/**
 * Replay Director - Preset: First Person Cinematic
 *
 * True POV: the camera sits at the subject's eye position (shifted by the
 * Height option) and looks exactly where they're looking, with a very
 * small, slow handheld-style sway. This is the only preset that puts the
 * camera essentially AT the subject's head rather than some distance away
 * from it - that's what makes it unmistakably different from Over The
 * Shoulder or Locked Face Camera, both of which view the subject from
 * outside.
 *
 * Distance/Height options ARE honored, adapted to what actually makes
 * sense for a POV shot (a first-person camera can't sensibly move "far"
 * from its own eyes without stopping being first-person): Height shifts
 * the eye position itself up/down (a genuinely different POV vantage -
 * "High" reads like standing on something, "Low" like crouching);
 * Distance controls how far ahead the gaze/focus point is placed, which
 * changes how "zoomed" the framing feels without moving the eye.
 *
 * LIMITATION (documented, not silently dropped): Replay Director's shots
 * run on Bedrock's `minecraft:free` camera, which detaches the viewport
 * from the player entity - it does not render the vanilla first-person
 * hand/held-item models the way actually being in first-person view
 * does. This preset gets the eye position and gaze direction right; it
 * just can't draw the subject's own hands into frame.
 */

import { HEIGHT_OFFSET, DISTANCE_METERS } from "./presetUtils.js";

export const FIRST_PERSON_CINEMATIC = {
    id: "first_person_cinematic",
    name: "First Person Cinematic",
    description: "True POV from the subject's own eyes, looking exactly where they look, with a subtle handheld sway.",
    defaultOptions: {
        durationTicks: 120,
        distance: "near",
        height: "eye",
        easing: "linear"
    },
    generate(subject, opts) {
        const eyeYOffset = HEIGHT_OFFSET[opts.height] ?? HEIGHT_OFFSET.eye;
        const gazeDistance = DISTANCE_METERS[opts.distance] ?? DISTANCE_METERS.near;
        const eye = { x: subject.headLocation.x, y: subject.headLocation.y + eyeYOffset, z: subject.headLocation.z };
        const yawRad = (subject.yaw * Math.PI) / 180;
        const forward = { x: -Math.sin(yawRad), z: Math.cos(yawRad) };

        return (t) => {
            const swayX = Math.sin(t * Math.PI * 1.6) * 0.03;
            const swayY = Math.sin(t * Math.PI * 2.3 + 1) * 0.02;

            const location = { x: eye.x + swayX, y: eye.y + swayY, z: eye.z };
            const facingLocation = {
                x: eye.x + forward.x * gazeDistance,
                y: eye.y,
                z: eye.z + forward.z * gazeDistance
            };
            return { location, facingLocation };
        };
    }
};
