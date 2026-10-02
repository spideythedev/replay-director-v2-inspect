/**
 * Replay Director - Preset: Chase Camera
 *
 * Sits directly behind the subject, low by default, close, with a fast,
 * tight shake - built to feel like the camera is being chased along with
 * them. Framing stays dead-center behind (no shoulder offset - that's
 * what Over The Shoulder is for), and the shake amplitude is deliberately
 * larger and faster here than anywhere else in the preset library, since
 * "urgency" is this preset's entire identity.
 *
 * Distance/Height options ARE honored (this preset previously hardcoded
 * a 2.6-block behind distance and a fixed 45%-of-body-height regardless
 * of menu selection) - Near/Medium/Far/Extreme change how far behind the
 * camera trails, Low/Eye/High/Very High shift it up or down from eye
 * level.
 */

import { yawVectors, DISTANCE_METERS, HEIGHT_OFFSET } from "./presetUtils.js";

const CHASE_FOV = 55;

export const CHASE_CAMERA = {
    id: "chase_camera",
    name: "Chase Camera",
    description: "Low, dead-center behind the subject with fast urgent shake - built for chases and fast action.",
    defaultOptions: {
        durationTicks: 140,
        distance: "near",
        height: "low",
        easing: "linear"
    },
    generate(subject, opts) {
        const { forward } = yawVectors(subject.yaw);
        const dist = DISTANCE_METERS[opts.distance] ?? DISTANCE_METERS.near;
        const camY = subject.headLocation.y + (HEIGHT_OFFSET[opts.height] ?? HEIGHT_OFFSET.low);

        return (t) => {
            const shakeX = Math.sin(t * Math.PI * 9) * 0.06;
            const shakeY = Math.sin(t * Math.PI * 11 + 2) * 0.04;
            const location = {
                x: subject.headLocation.x - forward.x * dist + shakeX,
                y: camY + shakeY,
                z: subject.headLocation.z - forward.z * dist
            };
            return {
                location,
                facingLocation: subject.headLocation,
                fov: CHASE_FOV
            };
        };
    }
};
