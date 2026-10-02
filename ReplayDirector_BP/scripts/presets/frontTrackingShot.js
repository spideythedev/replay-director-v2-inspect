/**
 * Replay Director - Preset: Front Tracking Shot
 *
 * Camera leads directly ahead of the subject, facing back at them -
 * walking-backward documentary style. Distinct from every other preset
 * by being IN FRONT of the subject rather than behind/beside/above/below
 * them, and by a small forward-backward "breathing" drift that mimics a
 * human operator walking backward rather than a perfectly rigid dolly -
 * that's what separates it from Side Tracking Shot's smooth lateral
 * glide.
 *
 * Distance/Height options ARE honored (this preset previously hardcoded
 * a base distance of 3.0 and a fixed 75%-of-body-height regardless of
 * menu selection) - Near/Medium/Far/Extreme change the base lead
 * distance the breathing drift oscillates around, Low/Eye/High/Very High
 * shift it up or down from eye level.
 */

import { yawVectors, DISTANCE_METERS, HEIGHT_OFFSET } from "./presetUtils.js";

export const FRONT_TRACKING_SHOT = {
    id: "front_tracking_shot",
    name: "Front Tracking Shot",
    description: "Leads directly ahead of the subject facing back at them, with a walking-backward drift.",
    defaultOptions: {
        durationTicks: 160,
        distance: "near",
        height: "eye",
        easing: "linear"
    },
    generate(subject, opts) {
        const { forward } = yawVectors(subject.yaw);
        const baseDist = DISTANCE_METERS[opts.distance] ?? DISTANCE_METERS.near;
        const camY = subject.headLocation.y + (HEIGHT_OFFSET[opts.height] ?? HEIGHT_OFFSET.eye);

        return (t) => {
            // Distance from subject breathes by +/-15% of the base lead
            // distance - an operator walking backward never holds a
            // perfectly fixed gap. This is the signature motion that makes
            // it read as "tracking" even with Follow The Player off.
            const dist = baseDist + Math.sin(t * Math.PI * 1.8) * baseDist * 0.15;
            const location = {
                x: subject.headLocation.x + forward.x * dist,
                y: camY,
                z: subject.headLocation.z + forward.z * dist
            };
            return {
                location,
                facingLocation: subject.headLocation
            };
        };
    }
};
