/**
 * Replay Director - Preset: Dual Player Focus
 *
 * A wide two-shot that slowly arcs around the midpoint between two
 * subjects, keeping both in frame - intended for use with the existing
 * "Center (Me + Them)" focus mode, which already builds a midpoint
 * subject via presetUtils.midpointSubject(). This preset's own math is
 * subject-agnostic like every other preset; it just uses a wider default
 * distance so two people comfortably fit in frame.
 * Distance/Height options ARE honored (this preset previously hardcoded
 * a fixed eye-level height regardless of menu selection) - Near/Medium/
 * Far/Extreme change the arc radius (scaled up 10% since this is meant
 * to comfortably frame two people), Low/Eye/High/Very High shift the
 * whole arc up or down from eye level.
 */

import { DISTANCE_METERS, HEIGHT_OFFSET, pointOnCircle } from "./presetUtils.js";

export const DUAL_PLAYER_FOCUS = {
    id: "dual_player_focus",
    name: "Dual Player Focus",
    description: "Wide two-shot that slowly arcs around a midpoint, keeping both subjects in frame. Use with Center (Me + Them) focus.",
    defaultOptions: {
        durationTicks: 180,
        distance: "far",
        height: "eye",
        easing: "ease_in_out"
    },
    generate(subject, opts) {
        const radius = (DISTANCE_METERS[opts.distance] ?? DISTANCE_METERS.far) * 1.1;
        const yOffset = subject.headLocation.y - subject.location.y + (HEIGHT_OFFSET[opts.height] ?? HEIGHT_OFFSET.eye);
        const startAngle = subject.yaw - 35;
        const endAngle = subject.yaw + 35;

        return (t) => {
            const angle = startAngle + (endAngle - startAngle) * t;
            const location = pointOnCircle(subject.location, radius, angle, yOffset);
            return {
                location,
                facingLocation: subject.headLocation
            };
        };
    }
};
