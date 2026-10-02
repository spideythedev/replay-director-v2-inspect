/**
 * Replay Director - Preset: Reveal Shot
 *
 * Auto-detects a nearby wall/tree/rock/building and starts the camera
 * hidden on the far side of it, then glides out into a clear view of the
 * subject - a sudden reveal. Falls back to a soft wide-to-close reveal if
 * nothing solid is nearby to hide behind.
 *
 * Collision avoidance is deliberately disabled for this preset - it would
 * otherwise "fix" the camera out of the hidden starting spot before the
 * reveal even happens.
 */

import { DISTANCE_METERS, HEIGHT_OFFSET, pointOnCircle } from "./presetUtils.js";
import { findNearbyObstruction } from "../camera/obstruction.js";

export const REVEAL_SHOT = {
    id: "reveal_shot",
    name: "Reveal Shot",
    description: "Auto-detects a nearby wall/tree/rock and glides out from behind it to reveal the subject.",
    disableCollision: true,
    defaultOptions: {
        durationTicks: 140,
        distance: "medium",
        height: "eye",
        easing: "ease_out"
    },
    generate(subject, opts, dimension) {
        const revealRadius = DISTANCE_METERS[opts.distance] ?? DISTANCE_METERS.medium;
        const heightOffset = HEIGHT_OFFSET[opts.height] ?? HEIGHT_OFFSET.eye;

        const obstruction = dimension ? findNearbyObstruction(dimension, subject.headLocation) : undefined;

        // No obstruction nearby: fall back to a soft reveal (far-and-low to
        // the normal framing) instead of failing.
        const angleDeg = obstruction ? obstruction.angleDeg : subject.yaw;
        const startRadius = obstruction ? obstruction.distance + 1.5 : revealRadius * 1.8;

        return (t) => {
            const radius = startRadius + (revealRadius - startRadius) * t;
            const location = pointOnCircle(
                subject.location,
                radius,
                angleDeg,
                subject.headLocation.y + heightOffset - subject.location.y
            );
            return {
                location,
                facingLocation: subject.headLocation
            };
        };
    }
};
