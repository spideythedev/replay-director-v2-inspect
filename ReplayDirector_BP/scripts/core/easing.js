/**
 * Replay Director - Easing Functions
 * All functions take t in [0,1] and return an eased t in [0,1].
 */

export function linear(t) {
    return t;
}

export function easeIn(t) {
    return t * t;
}

export function easeOut(t) {
    return 1 - (1 - t) * (1 - t);
}

export function easeInOut(t) {
    return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

export function getEasingFn(name) {
    switch (name) {
        case "ease_in":
            return easeIn;
        case "ease_out":
            return easeOut;
        case "ease_in_out":
            return easeInOut;
        case "linear":
        default:
            return linear;
    }
}

/** Linear interpolation between two numbers. */
export function lerp(a, b, t) {
    return a + (b - a) * t;
}

/** Interpolate between two {x,y,z} vectors. */
export function lerpVec3(a, b, t) {
    return {
        x: lerp(a.x, b.x, t),
        y: lerp(a.y, b.y, t),
        z: lerp(a.z, b.z, t)
    };
}
