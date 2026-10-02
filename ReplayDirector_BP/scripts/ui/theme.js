/**
 * Replay Director - Premium UI Theme
 *
 * Native server-ui forms do not expose arbitrary CSS/panel colors. This
 * theme therefore uses the supported ActionFormData/ModalFormData hierarchy
 * plus a restrained text palette. The page title is always the top-level
 * header; no section header is appended after the content.
 */

const COLORS = {
    white: "§f",
    accent: "§b",
    purple: "§5",
    muted: "§7",
    dim: "§8",
    black: "§3",
    success: "§2",
    warning: "§6",
    danger: "§4",
    info: "§1"
};

export function premiumTitle(name) {
    return `§l${COLORS.white}REPLAY DIRECTOR ${COLORS.dim}/ ${COLORS.accent}${name}`;
}

export function premiumBody(text) {
    return `${COLORS.muted}${text}`;
}

/**
 * Native forms render their title at the top of the panel. Older versions
 * of this project appended header()/divider() AFTER all buttons were built,
 * which caused the section header to appear at the bottom of the form.
 * Keep the existing call sites safe by making this helper title-only.
 */
export function premiumSection(form, text, title = text) {
    try {
        form.title(premiumTitle(title));
    } catch (e) {
        // fail soft
    }
    return form;
}

export function premiumHeader(text) {
    return `§l${COLORS.accent}${text}`;
}

export function premiumLabel(form, text) {
    try {
        form.label(`${COLORS.muted}${text}`);
    } catch (e) {
        // fail soft
    }
    return form;
}

export function premiumActive(text) {
    return `${COLORS.success}● ACTIVE ${COLORS.dim}| ${COLORS.black}${text}`;
}

export function premiumDisabled(text) {
    return `${COLORS.dim}○ ${text}`;
}

export function premiumPrimary(text) {
    return `${"§3"}${text}`;
}

export function premiumSecondary(text) {
    return `${COLORS.dim}${text}`;
}

export function premiumDanger(text) {
    return `${COLORS.danger}${text}`;
}

export function premiumBack(text = "Back") {
    return `${COLORS.black}‹ ${text}`;
}

export function premiumStatus(label, value, valueColor = COLORS.info) {
    return `${COLORS.muted}${label}: ${valueColor}${value}`;
}

export function premiumProgressBar(percent, width = 18) {
    const clamped = Math.max(0, Math.min(100, Math.round(percent)));
    const filled = Math.round((clamped / 100) * width);
    return `${COLORS.accent}${"━".repeat(filled)}${COLORS.dim}${"━".repeat(Math.max(0, width - filled))}`;
}

export { COLORS };
