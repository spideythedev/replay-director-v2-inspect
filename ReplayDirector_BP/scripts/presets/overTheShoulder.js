/**
 * Replay Director - Preset: Over The Shoulder
 *
 * A true over-the-shoulder shot: the camera sits close behind and to one
 * side of the subject's head, looking far ahead in the direction they're
 * facing, so their silhouette occupies one side of the frame while
 * whatever they're looking at fills the rest - the classic dialogue/
 * gameplay OTS composition.
 *
 * Distance/Height options ARE honored (this preset previously hardcoded
 * a 0.55-block side offset, 0.9-block behind offset, and +0.15 height
 * regardless of menu selection). Near/Medium/Far/Extreme now scale how
 * far behind and to the side the camera sits (a real over-the-shoulder
 * shot is always tight, so distances stay small - "Far" is a wider OTS,
 * not a different shot type), and Low/Eye/High/Very High shift it up or
 * down from eye level.
 *
 * Math note: every offset is measured relative to headLocation using
 * forward/right vectors, never re-derived through body height - a past
 * version of this file had a bug where subtracting body height from a
 * point already at head height dragged the camera down toward the feet.
 */

import { yawVectors, DISTANCE_METERS, HEIGHT_OFFSET } from "./presetUtils.js";

// OTS shots are inherently tight - even at the "Far" setting the camera
// should stay close enough to read as being on the subject's shoulder,
// so distance options are scaled down into a small, still-distinct range
// instead of using the full DISTANCE_METERS scale directly.
const MIN_SIDE = 0.4;
const MAX_SIDE = 1.3;
const MIN_BEHIND = 0.7;
const MAX_BEHIND = 1.6;

function scaleForDistance(distanceKey) {
    const raw = DISTANCE_METERS[distanceKey] ?? DISTANCE_METERS.near;
    const t = Math.min(1, (raw - DISTANCE_METERS.near) / (DISTANCE_METERS.extreme - DISTANCE_METERS.near));
    return {
        side: MIN_SIDE + (MAX_SIDE - MIN_SIDE) * t,
        behind: MIN_BEHIND + (MAX_BEHIND - MIN_BEHIND) * t
    };
}

export const OVER_THE_SHOULDER = {
    id: "over_the_shoulder",
    name: "Over The Shoulder",
    description: "Camera sits right behind one shoulder, peering past the subject in the direction they're facing.",
    defaultOptions: {
        durationTicks: 130,
        distance: "near",
        height: "eye",
        easing: "linear"
    },
    generate(subject, opts) {
        const { forward, right } = yawVectors(subject.yaw);
        const { side, behind } = scaleForDistance(opts.distance);
        const yOffset = HEIGHT_OFFSET[opts.height] ?? HEIGHT_OFFSET.eye;

        const camPos = {
            x: subject.headLocation.x + right.x * side - forward.x * behind,
            y: subject.headLocation.y + yOffset,
            z: subject.headLocation.z + right.z * side - forward.z * behind
        };

        const lookTarget = {
            x: subject.headLocation.x + forward.x * 25,
            y: subject.headLocation.y + yOffset - 0.1,
            z: subject.headLocation.z + forward.z * 25
        };

        return () => ({
            location: camPos,
            facingLocation: lookTarget
        });
    }
};
