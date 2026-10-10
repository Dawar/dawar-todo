import { EMOTIONS, STATES, hashSeed, type BotState, type Emotion } from './behaviors.js';
export { EMOTIONS, STATES, hashSeed, type BotState, type Emotion } from './behaviors.js';
export const SHAPES = ['circle', 'square', 'triangle', 'cloud', 'star', 'hexagon'] as const;
export const MOTION_STYLES = ['organic', 'springy', 'precise'] as const;
export const PALETTE = {
  lilac: '#9564F4',
  mint: '#36CFA0',
  coral: '#FF745F',
  sky: '#419DF5',
  butter: '#F3BE3D',
  graphite: '#6679B8',
} as const;
export type Shape = (typeof SHAPES)[number];
export type MotionStyle = (typeof MOTION_STYLES)[number];
export type BotColor = keyof typeof PALETTE | `#${string}`;
export type ReducedMotion = 'system' | 'always' | 'never';
export type AvatarEmote = 'spin';
export interface AvatarConfig {
  shape: Shape;
  color: BotColor;
  state: BotState;
  motion: MotionStyle;
  /** Automatic activity behavior, or an expression driven by application events. */
  emotion: 'auto' | Emotion;
  /** Stable identity controls blink timing, gaze, and phase. */
  seed: string | number;
  /** 0..1. Expression still communicates state at zero intensity. */
  intensity: number;
  /** 0.25..2. Time multiplier; does not change transition duration. */
  speed: number;
  /** Approximate settling time in milliseconds (150..2000). */
  transitionMs: number;
  paused: boolean;
  reducedMotion: ReducedMotion;
  shadow: boolean;
  /** Occasional idle hop-and-spins in organic and springy motion styles. */
  playful: boolean;
}
export const DEFAULT_CONFIG: Readonly<AvatarConfig> = Object.freeze({
  shape: 'circle',
  color: 'lilac',
  state: 'idle',
  motion: 'organic',
  emotion: 'auto',
  seed: 'littlebot',
  intensity: 0.6,
  speed: 1,
  transitionMs: 700,
  paused: false,
  reducedMotion: 'system',
  shadow: false,
  playful: true,
});
export function resolveColor(color: BotColor): string {
  if (Object.prototype.hasOwnProperty.call(PALETTE, color))
    return PALETTE[color as keyof typeof PALETTE];
  if (typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color)) return color.toUpperCase();
  throw new TypeError('Avatar color must be a palette name or a six-digit hex color.');
}
export function normalizeConfig(
  input: Partial<AvatarConfig> = {},
  base: AvatarConfig = { ...DEFAULT_CONFIG },
): AvatarConfig {
  // Copy only known, defined values. This also makes partially specified React props safe.
  const config = { ...base };
  for (const key of Object.keys(DEFAULT_CONFIG) as (keyof AvatarConfig)[]) {
    if (input[key] !== undefined) Object.assign(config, { [key]: input[key] });
  }
  const check = (valid: boolean, key: string) => {
    if (!valid) throw new TypeError(`Invalid avatar ${key}.`);
  };
  check(SHAPES.includes(config.shape), 'shape');
  check(STATES.includes(config.state), 'state');
  check(MOTION_STYLES.includes(config.motion), 'motion');
  check(config.emotion === 'auto' || EMOTIONS.includes(config.emotion), 'emotion');
  check(['system', 'always', 'never'].includes(config.reducedMotion), 'reducedMotion');
  check(
    typeof config.seed === 'string' ||
      (typeof config.seed === 'number' && Number.isFinite(config.seed)),
    'seed',
  );
  for (const [key, min, max] of [
    ['intensity', 0, 1],
    ['speed', 0.25, 2],
    ['transitionMs', 150, 2000],
  ] as const) {
    check(
      typeof config[key] === 'number' &&
        Number.isFinite(config[key]) &&
        config[key] >= min &&
        config[key] <= max,
      key,
    );
  }
  check(
    typeof config.paused === 'boolean' &&
      typeof config.shadow === 'boolean' &&
      typeof config.playful === 'boolean',
    'boolean options',
  );
  resolveColor(config.color);
  return config;
}
/** Derive a stable visual identity from a thread/bot ID. No backend needed. */
export function identityFromSeed(
  seed: string | number,
): Pick<AvatarConfig, 'seed' | 'shape' | 'color'> {
  const hash = hashSeed(seed);
  const colors = Object.keys(PALETTE) as (keyof typeof PALETTE)[];
  return {
    seed,
    shape: SHAPES[hash % SHAPES.length]!,
    color: colors[Math.floor(hash / SHAPES.length) % colors.length]!,
  };
}
export function parseConfig(json: string): AvatarConfig {
  const input: unknown = JSON.parse(json);
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new TypeError('Expected an avatar configuration object.');
  return normalizeConfig(input as Partial<AvatarConfig>);
}
