import { getTwoPlayerPair, lerpPoint, normalize2D } from "./twoPlayerUtils.js";
import { DISTANCE_METERS, HEIGHT_OFFSET } from "./presetUtils.js";

export const TWO_SHOT_ORBIT = {
    id: "two_shot_orbit",
    name: "Two-Shot Orbit",
    description: "Slow orbit that keeps both characters in the same cinematic frame.",
    requiresTwoPlayers: true,
    defaultOptions: { durationTicks: 120, distance: "far", height: "eye", easing: "ease_in_out" },
    generate(subject, opts, dimension, director) {
        const pair = getTwoPlayerPair(director);
        if (!pair) return () => ({ location: subject.headLocation, facingLocation: subject.headLocation });
        const a=pair.main.getHeadLocation(), b=pair.opponent.getHeadLocation();
        const mid=lerpPoint(a,b,0.5);
        const f=normalize2D(b.x-a.x,b.z-a.z);
        const baseAngle=Math.atan2(f.z,f.x);
        const radius=DISTANCE_METERS[opts.distance] ?? DISTANCE_METERS.far;
        const y=mid.y+(HEIGHT_OFFSET[opts.height] ?? 0);
        return (t) => {
            const angle=baseAngle+(-0.65+1.3*t);
            const loc={x:mid.x+Math.cos(angle)*radius,y,z:mid.z+Math.sin(angle)*radius};
            return {location:loc,facingLocation:mid};
        };
    }
};
