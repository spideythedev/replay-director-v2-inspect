import { getTwoPlayerPair, lerpPoint, normalize2D } from "./twoPlayerUtils.js";
import { DISTANCE_METERS, HEIGHT_OFFSET } from "./presetUtils.js";

export const STANDOFF = {
    id: "standoff",
    name: "Standoff",
    description: "Wide confrontation composition emphasizing the space between two characters.",
    requiresTwoPlayers: true,
    defaultOptions: { durationTicks: 100, distance: "far", height: "eye", easing: "linear" },
    generate(subject, opts, dimension, director) {
        const pair=getTwoPlayerPair(director);
        if (!pair) return () => ({location:subject.headLocation,facingLocation:subject.headLocation});
        const a=pair.main.location,b=pair.opponent.location;
        const mid=lerpPoint(a,b,0.5);
        const f=normalize2D(b.x-a.x,b.z-a.z);
        const side={x:-f.z,z:f.x};
        const radius=Math.max(8,(DISTANCE_METERS[opts.distance] ?? 9)*1.15);
        const y=mid.y+1.6+(HEIGHT_OFFSET[opts.height] ?? 0);
        const loc={x:mid.x+side.x*radius,y,z:mid.z+side.z*radius};
        return () => ({location:loc,facingLocation:{x:mid.x,y:mid.y+1.0,z:mid.z}});
    }
};
