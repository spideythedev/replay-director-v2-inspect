/**
 * Replay Director - Replay Skin Library
 *
 * Numbered-skin system: drop PNG files named skin1.png through skin15.png
 * directly into ReplayDirector_RP/textures/replay_skins/ - no code edits
 * needed. All 15 slots are already fully wired into the replay actor
 * entity (RP entity textures, render controller Array.skins, and this
 * list all agree on 15 slots) - this file just generates the id/name/
 * texture-path list for skin1..skin15 in a loop instead of one hardcoded
 * line per skin, so adding art is purely a file-drop.
 *
 * Any slot left empty (no matching PNG placed) falls back to whatever
 * Bedrock does for a missing texture reference - typically the game's
 * placeholder/invisible texture - rather than erroring, so it's safe to
 * only fill in as many of the 15 as you actually have art for.
 *
 * See textures/replay_skins/PLACE_SKINS_HERE.txt for the exact folder
 * path and file-naming details.
 */

const SKIN_COUNT = 15;

export const REPLAY_SKINS = Array.from({ length: SKIN_COUNT }, (_, i) => {
    const n = i + 1; // human-facing numbering: skin1..skin15
    return {
        id: `skin${n}`,
        name: `Skin ${n}`,
        texture: `textures/replay_skins/skin${n}`
    };
});

export function getSkinById(id) {
    return REPLAY_SKINS.find((s) => s.id === id);
}

export function getDefaultSkinId() {
    return REPLAY_SKINS.length > 0 ? REPLAY_SKINS[0].id : undefined;
}
