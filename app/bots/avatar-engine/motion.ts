import { hashSeed, EMOTIONS, type MotionStyle, type Emotion } from './config.js';
import { BehaviorPlayer, STATE_BEHAVIORS } from './behaviors.js';
export interface Spring {
  value: number;
  velocity: number;
}
/** Exact critically damped spring solution: stable across frame rates, keeps velocity on retarget. */
export function advanceSpring(
  spring: Spring,
  target: number,
  dt: number,
  durationMs: number,
): void {
  if (dt === 0) return;
  const omega = 6 / (durationMs / 1000);
  const offset = spring.value - target;
  const b = spring.velocity + omega * offset;
  const decay = Math.exp(-omega * dt);
  spring.value = target + (offset + b * dt) * decay;
  spring.velocity = (spring.velocity - omega * b * dt) * decay;
}
export interface Pose {
  x: number;
  y: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  gazeX: number;
  gazeY: number;
  eyeWidth: number;
  eyeHeight: number;
  eyeOpen: number;
  eyeLift: number;
  eyeTilt: number;
  eyeCurve: number;
  eyeSpacing: number;
  eyeAsymmetry: number;
  faceTurn: number;
  faceOpacity: number;
  shadowScale: number;
}
export const REST_POSE: Readonly<Pose> = Object.freeze({
  x: 0,
  y: 0,
  rotation: 0,
  scaleX: 1,
  scaleY: 1,
  gazeX: 0,
  gazeY: 0,
  eyeWidth: 15.5,
  eyeHeight: 24,
  eyeOpen: 1,
  eyeLift: 0,
  eyeTilt: 0,
  eyeCurve: 0,
  eyeSpacing: 12,
  eyeAsymmetry: 0,
  faceTurn: 0,
  faceOpacity: 1,
  shadowScale: 1,
});
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const smoothstep = (t: number) => t * t * (3 - 2 * t);
const LOOK_TARGETS = [
  [0, 0],
  [-0.9, -0.25],
  [0.75, -0.5],
  [0.35, 0.5],
  [0, -0.8],
  [-0.6, 0.3],
  [1, 0.1],
] as const;
/** Seeded glances ease into a point of interest, then hold instead of constantly wandering. */
export function sampleGaze(time: number, seed: string | number, working = false) {
  const period = working ? 1.35 : 2.8;
  const shifted = time + ((hashSeed(seed) % 1000) / 1000) * period;
  const beat = Math.floor(shifted / period);
  const elapsed = shifted - beat * period;
  const progress = smoothstep(Math.min(1, elapsed / (working ? 0.3 : 0.55)));
  const target = (index: number) =>
    LOOK_TARGETS[hashSeed(`${seed}:look:${index}`) % LOOK_TARGETS.length]!;
  const previous = target(beat - 1),
    next = target(beat);
  return {
    x: mix(previous[0], next[0], progress),
    y: mix(previous[1], next[1], progress),
  };
}
/** Pure deterministic sampler, also used independently by core consumers/tests. */
export function samplePose(
  time: number,
  seed: string | number,
  energy: number,
  style: MotionStyle,
  intensity: number,
  reduced = false,
): Pose {
  if (reduced) time = 0;
  const working = new BehaviorPlayer(STATE_BEHAVIORS.working, seed).step(Math.max(0, time));
  const idle = new BehaviorPlayer(STATE_BEHAVIORS.idle, seed).step(Math.max(0, time));
  return sampleEmotions(
    time,
    seed,
    style,
    intensity,
    EMOTIONS.map((_, i) => mix(idle[i]!, working[i]!, energy)),
    reduced,
  );
}

export function sampleEmotions(
  time: number,
  seed: string | number,
  style: MotionStyle,
  intensity: number,
  weights: readonly number[],
  reduced = false,
): Pose {
  const phase = ((hashSeed(seed) % 10000) / 10000) * Math.PI * 2;
  const period = 3.7 + (hashSeed(seed) % 170) / 100;
  const blinkTime = (time + phase) % period;
  const blink = !reduced && blinkTime < 0.18 ? Math.sin((blinkTime / 0.18) * Math.PI) ** 2 : 0;
  const eyeOpen = 1 - blink * 0.95;
  const pose = blendPoses(
    EMOTIONS.map((emotion) =>
      sampleEmotionPose(reduced ? 0 : time, seed, emotion, style, intensity, reduced),
    ),
    weights,
  );
  return { ...pose, eyeOpen, eyeHeight: pose.eyeHeight * eyeOpen };
}

function sampleEmotionPose(
  time: number,
  seed: string | number,
  mood: Emotion,
  style: MotionStyle,
  intensity: number,
  reduced: boolean,
): Pose {
  const phase = ((hashSeed(seed) % 1000) / 1000) * Math.PI * 2;
  const t = time + phase;
  const amount = reduced
    ? 0
    : intensity * (style === 'springy' ? 1.25 : style === 'precise' ? 0.4 : 1);
  const pulse = Math.sin(t * 9);
  const glance = sampleGaze(time, seed, true);
  let pose: Pose;
  switch (mood) {
    case 'resting': {
      const breath = Math.sin(t * 1.7);
      const gaze = sampleGaze(time, seed);
      const head = sampleGaze(time - 0.16, seed);
      pose = {
        ...REST_POSE,
        x: Math.sin(t * 0.93) * 1.2,
        y: -breath * 2.1,
        rotation: head.x * 4 + Math.sin(t * 0.82),
        scaleX: 1 - breath * 0.018,
        scaleY: 1 + breath * 0.026,
        gazeX: gaze.x * 6.5,
        gazeY: gaze.y * 4,
        eyeLift: gaze.x * 1.5,
      };
      break;
    }
    case 'curious': {
      const gaze = sampleGaze(time, seed);
      pose = {
        ...REST_POSE,
        eyeWidth: 16.5,
        eyeHeight: 28,
        eyeLift: gaze.x * 2,
        eyeAsymmetry: 0.12,
        gazeX: gaze.x * 8,
        gazeY: -3 + gaze.y * 3,
        rotation: gaze.x * 9,
        y: -2 + Math.sin(t * 2) * 1.4,
        scaleX: 0.97,
        scaleY: 1.04,
      };
      break;
    }
    case 'sleepy': {
      const droop = Math.sin(t * 1.1);
      pose = {
        ...REST_POSE,
        eyeWidth: 17,
        eyeHeight: 8,
        eyeTilt: -6,
        gazeY: 3,
        y: 3 + droop,
        rotation: 5 + droop * 3,
        scaleX: 1.035,
        scaleY: 0.955,
      };
      break;
    }
    case 'focused':
      pose = {
        ...REST_POSE,
        eyeWidth: 18,
        eyeHeight: 12,
        eyeTilt: 17,
        gazeY: 3,
        gazeX: glance.x * 2.5,
        rotation: -7 + Math.sin(t * 2) * 2,
        y: 2,
        scaleX: 1.025,
        scaleY: 0.97,
      };
      break;
    case 'determined':
      pose = {
        ...REST_POSE,
        eyeWidth: 19,
        eyeHeight: 8.5,
        eyeTilt: 29,
        eyeSpacing: 11,
        gazeY: 4,
        x: Math.sin(t * 12) * 1.7,
        y: 3 + pulse * 2,
        rotation: -8 + pulse * 4,
        scaleX: 1.08 + pulse * 0.035,
        scaleY: 0.89 - pulse * 0.04,
      };
      break;
    case 'frustrated': {
      const burst = Math.max(0, Math.sin(t * 2.8)) ** 2;
      pose = {
        ...REST_POSE,
        eyeWidth: 20,
        eyeHeight: 6.5,
        eyeTilt: 34,
        eyeSpacing: 10.5,
        gazeY: 3,
        eyeLift: -1,
        x: Math.sin(t * 36) * 3.5 * burst,
        y: 5 + burst,
        rotation: Math.sin(t * 28) * 9 * burst,
        scaleX: 1.12 + burst * 0.025,
        scaleY: 0.84 - burst * 0.025,
      };
      break;
    }
    case 'thinking':
      pose = {
        ...REST_POSE,
        eyeWidth: 15,
        eyeHeight: 23,
        gazeX: -4.5,
        gazeY: -4,
        rotation: 7 + Math.sin(t * 1.6) * 1.5,
        y: -1,
        scaleX: 0.96,
        scaleY: 1.04,
      };
      break;
    case 'testing': {
      const nod = Math.sin(t * 5.5);
      pose = {
        ...REST_POSE,
        eyeWidth: 16,
        eyeHeight: 18,
        eyeTilt: 8,
        gazeX: glance.x * 4,
        gazeY: 1 + nod * 2,
        y: nod * 3,
        rotation: -3 + nod * 5,
        scaleX: 1 - nod * 0.03,
        scaleY: 1 + nod * 0.04,
      };
      break;
    }
    case 'happy': {
      const hop = Math.max(0, Math.sin(t * 6));
      const land = Math.max(0, -Math.sin(t * 6));
      pose = {
        ...REST_POSE,
        eyeWidth: 19,
        eyeHeight: 17,
        eyeTilt: -4,
        eyeCurve: 1,
        eyeSpacing: 13,
        gazeY: -1,
        y: -10 * hop + 2 * land,
        rotation: Math.sin(t * 3) * 6,
        scaleX: 1 + land * 0.09 - hop * 0.025,
        scaleY: 1 - land * 0.09 + hop * 0.04,
      };
      break;
    }
  }
  return {
    ...pose,
    x: pose.x * amount,
    y: pose.y * amount,
    rotation: pose.rotation * amount,
    scaleX: 1 + (pose.scaleX - 1) * amount,
    scaleY: 1 + (pose.scaleY - 1) * amount,
    gazeX: pose.gazeX * amount,
    gazeY: pose.gazeY * amount,
    shadowScale: 1 - pose.y * amount * 0.025,
  };
}

/** A shared eyelid contour morphs from an oval to an upward happy crescent. */
export function eyePath(curve: number): string {
  const bottom = 1 - curve * 1.4;
  const handle = 0.5523 * (1 - curve);
  return `M-1 0 C-1 -.5523 -.5523 -1 0 -1 C.5523 -1 1 -.5523 1 0 C1 ${handle} .5523 ${bottom} 0 ${bottom} C-.5523 ${bottom} -1 ${handle} -1 0Z`;
}
export const SPIN_DURATION = 1.65;
const unit = (value: number) => Math.max(0, Math.min(1, value));
/** Add a temporary hop and full turn without interrupting the underlying state motion. */
export function applySpin(pose: Pose, elapsed: number, intensity: number): Pose {
  const progress = unit(elapsed / SPIN_DURATION);
  const turn = smoothstep(unit((progress - 0.16) / 0.65)) * Math.PI * 2;
  const hop = Math.sin(unit((progress - 0.14) / 0.74) * Math.PI);
  const anticipation = Math.sin(unit(progress / 0.14) * Math.PI);
  const landing = Math.sin(unit((progress - 0.88) / 0.12) * Math.PI);
  const compression = (anticipation * 0.08 + landing * 0.1) * (0.65 + intensity * 0.35);
  return {
    ...pose,
    y: Math.max(-16, pose.y - hop * 14 * (0.65 + intensity * 0.35)),
    rotation: pose.rotation + Math.sin(turn) * 4,
    scaleX: pose.scaleX * (1 + compression - Math.abs(Math.sin(turn)) * 0.08),
    scaleY: pose.scaleY * (1 - compression),
    faceTurn: turn,
    faceOpacity: smoothstep(unit(Math.cos(turn) / 0.28)),
    shadowScale: pose.shadowScale + hop * 0.35,
  };
}
export function blendPoses(poses: readonly Pose[], weights: readonly number[]): Pose {
  const output = { ...REST_POSE };
  for (const key of Object.keys(output) as (keyof Pose)[])
    output[key] = poses.reduce((sum, pose, index) => sum + pose[key] * weights[index]!, 0);
  return output;
}
