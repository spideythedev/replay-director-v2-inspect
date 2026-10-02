/**
 * Replay Director - Preset: Side Tracking Shot
 *
 * A profile shot from directly to one side of the subject - a smooth,
 * level, unwavering lateral glide, like a camera on rails running
 * parallel to them. Deliberately has NO shake, sway, or distance
 * breathing (unlike Front Tracking Shot's walking-backward drift or
 * Chase Camera's handheld urgency) - a rock-steady dolly-track feel is
 * this preset's whole identity, and it's what makes it read as different
 * the instant it's selected.
 *
 * Distance/Height options ARE honored (this preset previously hardcoded
 * a fixed 5-block distance at eye height regardless of menu selection) -
 * Near/Medium/Far/Extreme change how far to the side the camera sits,
 * Low/Eye/High/Very High shift it up or down from eye level.
 */

import { yawVectors, DISTANCE_METERS, HEIGHT_OFFSET } from "./presetUtils.js";

export const SIDE_TRACKING_SHOT = {
    id: "side_tracking_shot",
    name: "Side Tracking Shot",
    description: "Smooth, level profile shot from directly to one side of the subject - a steady parallel dolly track.",
    defaultOptions: {
        durationTicks: 160,
        distance: "medium",
        height: "eye",
        easing: "linear"
    },
    generate(subject, opts) {
        const { right } = yawVectors(subject.yaw);
        const dist = DISTANCE_METERS[opts.distance] ?? DISTANCE_METERS.medium;
        const camY = subject.headLocation.y + (HEIGHT_OFFSET[opts.height] ?? HEIGHT_OFFSET.eye);

        const camPos = {
            x: subject.headLocation.x + right.x * dist,
            y: camY,
            z: subject.headLocation.z + right.z * dist
        };

        return () => ({
            location: camPos,
            facingLocation: subject.headLocation
        });
    }
};
