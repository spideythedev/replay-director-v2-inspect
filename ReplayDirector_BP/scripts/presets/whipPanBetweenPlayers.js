/**
 * Replay Director - Preset: Whip Pan Between Players
 *
 * A fast snap-pan from one subject to another mid-shot, like a hard whip
 * pan cut. Needs two players, so it resolves its own pair (nearest to the
 * director + the director) rather than using the normal single-subject
 * focus flow - this preset ignores the passed-in subject snapshot and
 * builds its shot directly from the two live players instead, since a
 * whip pan is inherently a two-subject shot.
 */

import { pointOnCircle } from "./presetUtils.js";
import { findAutoTarget } from "../camera/targeting.js";
import { world } from "@minecraft/server";

export const WHIP_PAN_BETWEEN_PLAYERS = {
    id: "whip_pan_between_players",
    name: "Whip Pan Between Players",
    description: "Fast snap-pan from the director to the nearest other player, mid-shot.",
    requiresTwoPlayers: true,
    defaultOptions: {
        durationTicks: 40,
        distance: "medium",
        height: "eye",
        easing: "ease_in_out"
    },
    /**
     * @param {{location:object, headLocation:object, yaw:number}} subject - the primary subject (camera stays fixed relative to this one)
     * @param {object} opts
     * @param {import("@minecraft/server").Dimension} dimension
     * @param {import("@minecraft/server").Player} [director] - used to find the second subject to whip toward
     */
    generate(subject, opts, dimension, director) {
        // Exclude BOTH the director and whoever the primary subject already
        // is (they may be the same person, e.g. focus mode "self", or two
        // different people, e.g. focus mode "front") - otherwise a whip pan
        // whose subject is already "the nearest other player" would just
        // find that same player again as the "second" one and whip pan to
        // itself.
        let other;
        if (director) {
            const subjectLoc = subject.location;
            other = world
                .getAllPlayers()
                .filter((p) => p.isValid && p.id !== director.id)
                .filter((p) => {
                    const d = Math.hypot(p.location.x - subjectLoc.x, p.location.y - subjectLoc.y, p.location.z - subjectLoc.z);
                    return d > 0.5; // not the same entity the subject snapshot came from
                })
                .sort((a, b) => {
                    const da = Math.hypot(a.location.x - subjectLoc.x, a.location.y - subjectLoc.y, a.location.z - subjectLoc.z);
                    const db = Math.hypot(b.location.x - subjectLoc.x, b.location.y - subjectLoc.y, b.location.z - subjectLoc.z);
                    return da - db;
                })[0];
            if (!other) other = findAutoTarget(director);
        }
        const otherHead = other && other.isValid ? other.getHeadLocation() : subject.headLocation;

        const camPos = pointOnCircle(subject.headLocation, 4, subject.yaw + 180, 0.5);

        return (t) => {
            // First 40% holds on the primary subject, then whips fast to
            // the second, then holds - reads as a snap pan, not a smooth pan.
            let target;
            if (t < 0.4) {
                target = subject.headLocation;
            } else if (t < 0.6) {
                const whipT = (t - 0.4) / 0.2;
                target = {
                    x: subject.headLocation.x + (otherHead.x - subject.headLocation.x) * whipT,
                    y: subject.headLocation.y + (otherHead.y - subject.headLocation.y) * whipT,
                    z: subject.headLocation.z + (otherHead.z - subject.headLocation.z) * whipT
                };
            } else {
                target = otherHead;
            }
            return {
                location: camPos,
                facingLocation: target
            };
        };
    }
};
