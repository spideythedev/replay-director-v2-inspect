/**
 * Replay Director - Preset Registry
 *
 * 28 existing presets + 5 new cinematic presets - 33 total. The expansion pass originally added 28 presets, but many
 * turned out to be near-duplicates of each other (same "point on a circle,
 * look at the head" skeleton with only angle/radius numbers changed) or of
 * existing presets. Per an explicit quality-over-quantity redesign pass,
 * everything redundant was cut and every survivor was rebuilt with a
 * genuinely distinct camera behavior - not just distinct numbers. See each
 * preset file's header comment for what specifically makes it different
 * from its nearest neighbors.
 */

import { HERO_SHOT } from "./heroShot.js";
import { ORBIT_LEFT } from "./orbitLeft.js";
import { ORBIT_RIGHT } from "./orbitRight.js";
import { PUSH_IN } from "./pushIn.js";
import { PULL_OUT } from "./pullOut.js";
import { REVERSE_DOLLY } from "./reverseDolly.js";
import { DOLLY_ZOOM } from "./dollyZoom.js";
import { BIRDS_EYE } from "./birdsEye.js";
import { CRANE_UP } from "./craneUp.js";
import { CRANE_DOWN } from "./craneDown.js";
import { LOW_ANGLE } from "./lowAngle.js";
import { HIGH_ANGLE } from "./highAngle.js";
import { FLYING_DRONE } from "./flyingDrone.js";
import { REVEAL_SHOT } from "./revealShot.js";

import { FIRST_PERSON_CINEMATIC } from "./firstPersonCinematic.js";
import { OVER_THE_SHOULDER } from "./overTheShoulder.js";
import { CHASE_CAMERA } from "./chaseCamera.js";
import { FRONT_TRACKING_SHOT } from "./frontTrackingShot.js";
import { SIDE_TRACKING_SHOT } from "./sideTrackingShot.js";
import { SPIRAL_ORBIT } from "./spiralOrbit.js";
import { ACTION_FOLLOW_CAMERA } from "./actionFollowCamera.js";
import { WHIP_PAN_BETWEEN_PLAYERS } from "./whipPanBetweenPlayers.js";
import { DUAL_PLAYER_FOCUS } from "./dualPlayerFocus.js";
import { CIRCLE_REVEAL } from "./circleReveal.js";
import { HERO_ENTRANCE } from "./heroEntrance.js";
import { WALK_AND_TALK_CAMERA } from "./walkAndTalkCamera.js";

import { SPEED_ZOOM } from "./speedZoom.js";
import { SNAP_ORBIT } from "./snapOrbit.js";
import { PARALLAX_SLIDE } from "./parallaxSlide.js";
import { GROUND_SKIM } from "./groundSkim.js";
import { AERIAL_DIVE } from "./aerialDive.js";
import { DUEL_OTS } from "./duelOts.js";
import { LEGS_REVEAL } from "./legsReveal.js";
import { FACE_TO_FACE } from "./faceToFace.js";
import { TWO_SHOT_ORBIT } from "./twoShotOrbit.js";
import { STANDOFF } from "./standoff.js";


export const PRESETS = [
    HERO_SHOT,
    ORBIT_LEFT,
    ORBIT_RIGHT,
    PUSH_IN,
    PULL_OUT,
    REVERSE_DOLLY,
    DOLLY_ZOOM,
    BIRDS_EYE,
    CRANE_UP,
    CRANE_DOWN,
    LOW_ANGLE,
    HIGH_ANGLE,
    FLYING_DRONE,
    REVEAL_SHOT,

    FIRST_PERSON_CINEMATIC,
    OVER_THE_SHOULDER,
    CHASE_CAMERA,
    FRONT_TRACKING_SHOT,
    SIDE_TRACKING_SHOT,
    SPIRAL_ORBIT,
    ACTION_FOLLOW_CAMERA,
    WHIP_PAN_BETWEEN_PLAYERS,
    DUAL_PLAYER_FOCUS,
    CIRCLE_REVEAL,
    HERO_ENTRANCE,
    WALK_AND_TALK_CAMERA,
    SPEED_ZOOM,
    SNAP_ORBIT,
    PARALLAX_SLIDE,
    GROUND_SKIM,
    AERIAL_DIVE,
    DUEL_OTS,
    LEGS_REVEAL,
    FACE_TO_FACE,
    TWO_SHOT_ORBIT,
    STANDOFF
];

export function getPresetById(id) {
    return PRESETS.find((p) => p.id === id);
}
