/**
 * Replay Director - Preset: Action Follow Camera
 *
 * A wide three-quarter angle, elevated above eye level, that continuously
 * sweeps around the subject across the full shot - like a camera operator
 * circling a fight rather than chasing from directly behind it. This is
 * what separates it from Chase Camera (dead-center behind, low, tight
 * shake, no orbit) and from Orbit Left/Right (constant speed, fixed
 * height, always a full 360): Action Follow Camera only sweeps a wide
 * arc, stays elevated throughout, and uses a wide FOV to keep fast lateral
 * movement readable in frame.
 *
 * Distance/Height options ARE honored (this preset previously hardcoded
 * a fixed +2.4 height offset regardless of menu selection) - Near/Medium/
 * Far/Extreme change the sweep radius, Low/Eye/High/Very High change how
 * elevated the sweep sits.
 */

import { DISTANCE_METERS, HEIGHT_OFFSET, pointOnCircle } from "./presetUtils.js";

const ACTION_FOV = 50;
const SWEEP_DEGREES = 140;

export const ACTION_FOLLOW_CAMERA = {
    id: "action_follow_camera",
    name: "Action Follow Camera",
    description: "Wide elevated angle that sweeps around the subject across the shot - a camera operator circling the action.",
    defaultOptions: {
        durationTicks: 180,
        distance: "medium",
        height: "high",
        easing: "linear"
    },
    generate(subject, opts) {
        const radius = DISTANCE_METERS[opts.distance] ?? DISTANCE_METERS.medium;
        const yOffset = subject.headLocation.y - subject.location.y + (HEIGHT_OFFSET[opts.height] ?? HEIGHT_OFFSET.high);
        const startAngle = subject.yaw - SWEEP_DEGREES / 2;
        const endAngle = subject.yaw + SWEEP_DEGREES / 2;

        return (t) => {
            const angle = startAngle + (endAngle - startAngle) * t;
            const location = pointOnCircle(subject.location, radius, angle, yOffset);
            return {
                location,
                facingLocation: subject.headLocation,
                fov: ACTION_FOV
            };
        };
    }
};
