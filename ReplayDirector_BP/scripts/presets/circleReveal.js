/**
 * Replay Director - Preset: Circle Reveal
 *
 * The camera stays close and tight throughout (unlike Reveal Shot, which
 * glides in from far away) and sweeps a half-circle from directly behind
 * the subject around to directly in front, with the sweep speed
 * deliberately slow through the first 70% and then snapping through the
 * final 30% - a "hold... hold... whip to face-on" rhythm, distinct from
 * Reveal Shot's real-obstruction-hide mechanic and from any of the
 * constant-speed orbit presets.
 *
 * Distance/Height options ARE honored (this preset previously hardcoded
 * a fixed 2.4-block radius at eye height regardless of menu selection).
 * Kept in a tight scaled range like Over The Shoulder/Close Action - this
 * is meant to stay a close reveal even at "Far", or it stops reading as
 * an intimate reveal and becomes a generic wide orbit.
 */

import { DISTANCE_METERS, HEIGHT_OFFSET, pointOnCircle } from "./presetUtils.js";

const MIN_RADIUS = 1.8;
const MAX_RADIUS = 4;

function scaleForDistance(distanceKey) {
    const raw = DISTANCE_METERS[distanceKey] ?? DISTANCE_METERS.near;
    const t = Math.min(1, (raw - DISTANCE_METERS.near) / (DISTANCE_METERS.extreme - DISTANCE_METERS.near));
    return MIN_RADIUS + (MAX_RADIUS - MIN_RADIUS) * t;
}

export const CIRCLE_REVEAL = {
    id: "circle_reveal",
    name: "Circle Reveal",
    description: "Tight half-circle sweep from behind the subject to face-on, holding back then whipping through to the reveal.",
    defaultOptions: {
        durationTicks: 110,
        distance: "near",
        height: "eye",
        easing: "linear"
    },
    generate(subject, opts) {
        const radius = scaleForDistance(opts.distance);
        const yOffset = subject.headLocation.y - subject.location.y + (HEIGHT_OFFSET[opts.height] ?? HEIGHT_OFFSET.eye);
        const startAngle = subject.yaw + 180;
        const endAngle = subject.yaw;

        return (t) => {
            let sweepT;
            if (t < 0.7) {
                sweepT = (t / 0.7) * 0.3;
            } else {
                sweepT = 0.3 + ((t - 0.7) / 0.3) * 0.7;
            }
            const angle = startAngle + (endAngle - startAngle) * sweepT;
            const location = pointOnCircle(subject.location, radius, angle, yOffset);
            return {
                location,
                facingLocation: subject.headLocation
            };
        };
    }
};
