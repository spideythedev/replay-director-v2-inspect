/**
 * Replay Director - Preset: Speed Zoom
 *
 * A fast cinematic punch-in: the camera starts wide, rushes toward the
 * subject early in the shot, then settles. A small animated FOV change
 * reinforces the "speed zoom" feeling without becoming a full Dolly Zoom.
 */
import { DISTANCE_METERS, HEIGHT_OFFSET, pointOnCircle } from "./presetUtils.js";
import { getPresetFov } from "../core/settings.js";

export const SPEED_ZOOM = {
    id: "speed_zoom",
    name: "Speed Zoom",
    description: "Fast cinematic punch-in with a brief zoom burst and soft settle.",
    sway: false,
    defaultOptions: {
        durationTicks: 70,
        distance: "far",
        height: "eye",
        easing: "ease_in_out"
    },
    generate(subject, opts) {
        const endRadius = DISTANCE_METERS[opts.distance] ?? DISTANCE_METERS.far;
        const startRadius = Math.max(endRadius * 2.1, endRadius + 4);
        const heightOffset = HEIGHT_OFFSET[opts.height] ?? HEIGHT_OFFSET.eye;
        const startFov = getPresetFov();
        const endFov = Math.max(35, startFov - 7);
        const startAngle = subject.yaw + 180;
        const endAngle = subject.yaw + 168;

        return (t) => {
            const burst = 1 - Math.pow(1 - t, 4);
            const radius = startRadius + (endRadius - startRadius) * burst;
            const angle = startAngle + (endAngle - startAngle) * t;
            const location = pointOnCircle(
                subject.location,
                radius,
                angle,
                subject.headLocation.y + heightOffset - subject.location.y
            );
            const fov = startFov + (endFov - startFov) * burst;
            return {
                location,
                facingLocation: subject.headLocation,
                fov,
                animatedFov: true
            };
        };
    }
};
