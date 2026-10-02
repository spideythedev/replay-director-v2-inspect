/**
 * Replay Director - Preset: Dolly Zoom
 *
 * The classic "vertigo effect": the camera physically pushes toward the
 * subject while the FOV widens at the same time (or the reverse), so the
 * subject stays roughly the same size on screen while the background
 * warps and compresses/expands around them.
 */

import { DISTANCE_METERS, HEIGHT_OFFSET, pointOnCircle } from "./presetUtils.js";
import { getPresetFov } from "../core/settings.js";

const END_FOV = 75;

export const DOLLY_ZOOM = {
    id: "dolly_zoom",
    name: "Dolly Zoom",
    description: "Vertigo effect - pushes in while the FOV widens, warping the background.",
    // The Vertigo effect must not receive handheld sway: any extra
    // camera displacement changes the subject-to-camera distance and
    // defeats the framing math below.
    sway: false,
    defaultOptions: { durationTicks: 120, distance: "far", height: "eye", easing: "ease_in_out" },
    generate(subject, opts) {
        const startRadius = DISTANCE_METERS[opts.distance] ?? DISTANCE_METERS.far;
        const heightOffset = HEIGHT_OFFSET[opts.height] ?? HEIGHT_OFFSET.eye;
        const angle = subject.yaw;
        const startFov = getPresetFov(); // dolly zoom starts from the user's global Preset FOV.

        // A true dolly zoom keeps the subject's apparent size approximately
        // constant by preserving D * tan(FOV / 2), rather than moving the
        // camera a fixed percentage of the way toward the subject. This is
        // the key mathematical relationship behind the Vertigo effect.
        const startFovRad = (startFov * Math.PI) / 180;
        const startFramingConstant = startRadius * Math.tan(startFovRad / 2);

        return (t) => {
            const fov = startFov + (END_FOV - startFov) * t;
            const fovRad = (fov * Math.PI) / 180;
            const radius = Math.max(
                1.5,
                startFramingConstant / Math.tan(fovRad / 2)
            );
            const location = pointOnCircle(subject.location, radius, angle, subject.headLocation.y + heightOffset - subject.location.y);
            return {
                location,
                facingLocation: subject.headLocation,
                fov,
                // Global Preset FOV pass: this fov is the dolly zoom effect
                // itself (30->75 animated across the shot), not a fixed
                // preference like Chase Camera's old constant - so it must
                // keep driving the camera every tick instead of being
                // replaced by the single global FOV value. animatedFov
                // tells cameraRunner.js to keep applying frame.fov for this
                // preset specifically; every other preset is unaffected.
                animatedFov: true
            };
        };
    }
};
