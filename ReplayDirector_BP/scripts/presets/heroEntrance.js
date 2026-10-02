/**
 * Replay Director - Preset: Hero Entrance
 *
 * An actual entrance move: starts high and directly behind the subject
 * (their back to camera, face not yet visible - unlike Hero Shot, which
 * is front-facing for its entire duration), then swoops down and around
 * in a single continuous arc to land on a low front-facing hero angle by
 * the end. The shot only resembles Hero Shot in its final ~15%; the rest
 * is a distinct behind-to-front descending swoop, which is what makes it
 * read as a build-up to a reveal rather than a bigger version of the
 * same static shot.
 *
 * Distance/Height options ARE honored (this preset previously accepted
 * opts but never read it - the landing radius/height were hardcoded
 * regardless of menu selection). Distance/Height now control where the
 * shot LANDS (the final hero angle); the starting position is always
 * kept proportionally further out and higher than the landing point so
 * the swoop still reads as a real entrance at every distance/height
 * setting instead of collapsing into a flat pan when Near/Low is picked.
 */

import { DISTANCE_METERS, HEIGHT_OFFSET } from "./presetUtils.js";

export const HERO_ENTRANCE = {
    id: "hero_entrance",
    name: "Hero Entrance",
    description: "Swoops from high behind the subject, around and down, landing on a low powerful front-facing angle - a build-up to a reveal.",
    defaultOptions: {
        durationTicks: 150,
        distance: "medium",
        height: "low",
        easing: "ease_in_out"
    },
    generate(subject, opts) {
        const endRadius = DISTANCE_METERS[opts.distance] ?? DISTANCE_METERS.medium;
        const endHeight = subject.headLocation.y - subject.location.y + (HEIGHT_OFFSET[opts.height] ?? HEIGHT_OFFSET.low);

        const startAngle = subject.yaw + 180; // directly behind
        const endAngle = subject.yaw; // directly in front, the Hero Shot angle
        const startRadius = endRadius * 1.6; // always noticeably further out than it lands
        const startHeight = endHeight + 6; // always noticeably higher than it lands

        return (t) => {
            const angle = startAngle + (endAngle - startAngle) * t;
            const radius = startRadius + (endRadius - startRadius) * t;
            const yOffset = startHeight + (endHeight - startHeight) * t;
            const rad = (angle * Math.PI) / 180;
            const location = {
                x: subject.location.x - radius * Math.sin(rad),
                y: subject.location.y + yOffset,
                z: subject.location.z + radius * Math.cos(rad)
            };
            return {
                location,
                facingLocation: subject.headLocation
            };
        };
    }
};
