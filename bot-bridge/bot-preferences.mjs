import { randomInt, randomUUID } from 'node:crypto';

// bot-avatar-engine 6ee5b14cad35bf45c16042b25a2aec88c924af81/config.ts.
export const AVATAR_SHAPES = ['circle', 'square', 'triangle', 'cloud', 'star', 'hexagon'];
export const AVATAR_COLORS = ['lilac', 'mint', 'coral', 'sky', 'butter', 'graphite'];
export function initialPreferences() {
  return { burstQuietSeconds: 8, avatar: { version: 1, shape: AVATAR_SHAPES[randomInt(AVATAR_SHAPES.length)],
    color: AVATAR_COLORS[randomInt(AVATAR_COLORS.length)], seed: randomUUID() } };
}
export function preferencePatch(bot, params) {
  const patch = {};
  if (params.burstQuietSeconds !== undefined) {
    if (![0, 3, 8, 15].includes(params.burstQuietSeconds)) throw new Error('Choose Off, 3, 8 or 15 seconds.');
    patch.burstQuietSeconds = params.burstQuietSeconds;
  }
  if (params.avatar !== undefined) {
    const a = params.avatar;
    if (!a || typeof a !== 'object' || Array.isArray(a) || Object.keys(a).some(k => !['shape', 'color'].includes(k)) ||
        !AVATAR_SHAPES.includes(a.shape) || !(AVATAR_COLORS.includes(a.color) || /^#[0-9a-fA-F]{6}$/.test(a.color)))
      throw new Error('Choose a supported avatar shape and palette or six-digit color.');
    patch.avatar = { version: 1, shape: a.shape, color: a.color, seed: bot.avatar?.seed ?? randomUUID() };
  }
  return patch;
}
