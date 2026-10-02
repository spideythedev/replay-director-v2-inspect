/**
 * Replay Director - Preset: Walk & Talk Camera
 *
 * A calm three-quarter angle - neither Side Tracking Shot's dead-90-degree
 * profile nor Front Tracking Shot's dead-ahead walking-backward view, but
 * a 55-degree diagonal that reads as "keeping pace alongside and slightly
 * ahead," the classic walk-and-talk conversational framing. Zero shake
 * (unlike Chase/Close Action) and no distance-breathing (unlike Front
 * Tracking) - instead it has a very slow, wide side-to-side drift in the
 * viewing angle itself, mimicking a camera operator gently arcing to keep
 * the conversation framed rather than walking in a straight line.
 *
 * Distance/Height options ARE honored (this preset previously hardcoded
 * a 3.4-block radius and a fixed 85%-of-body-height regardless of menu
 * selection) - Near/Medium/Far/Extreme change how far to the side the
 * camera sits, Low/Eye/High/Very High shift it up or down from eye level.
 */

import { DISTANCE_METERS, HEIGHT_OFFSET } from "./presetUtils.js";

export const WALK_AND_TALK_CAMERA = {
    id: "walk_and_talk_camera",
    name: "Walk & Talk Camera",
    description: "Calm three-quarter diagonal angle with a slow arcing drift - the classic walk-and-talk conversational shot.",
    defaultOptions: {
        durationTicks: 220,
        distance: "near",
        height: "eye",
        easing: "linear"
    },
    generate(subject, opts) {
        const baseAngle = subject.yaw + 55;
        const radius = DISTANCE_METERS[opts.distance] ?? DISTANCE_METERS.near;
        const camY = subject.headLocation.y + (HEIGHT_OFFSET[opts.height] ?? HEIGHT_OFFSET.eye);

        return (t) => {
            // Very slow arc drift (+/- 8 degrees over the whole shot,
            // one full cycle) - much slower and gentler than any orbit
            // preset, and unlike them it's not trying to circle the
            // subject, just gently re-angle around a fixed diagonal.
            const angle = baseAngle + Math.sin(t * Math.PI * 2) * 8;
            const yawRad = (angle * Math.PI) / 180;
            const location = {
                x: subject.headLocation.x - radius * Math.sin(yawRad),
                y: camY,
                z: subject.headLocation.z + radius * Math.cos(yawRad)
            };
            return {
                location,
                facingLocation: subject.headLocation
            };
        };
    }
};
