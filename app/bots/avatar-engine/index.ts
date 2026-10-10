export { AvatarEngine, type AvatarFrame, type AvatarEvent, type AvatarLogger } from './engine.js';
export { mountAvatar, type AvatarController, type MountOptions } from './renderer.js';
export {
  DEFAULT_CONFIG,
  PALETTE,
  SHAPES,
  STATES,
  EMOTIONS,
  type Emotion,
  MOTION_STYLES,
  identityFromSeed,
  normalizeConfig,
  parseConfig,
  resolveColor,
  type AvatarConfig,
  type AvatarEmote,
  type BotState,
  type BotColor,
  type MotionStyle,
  type Shape,
  type ReducedMotion,
} from './config.js';
export { getSchedulerStats } from './scheduler.js';
export { STATE_BEHAVIORS, type BehaviorRecipe } from './behaviors.js';
