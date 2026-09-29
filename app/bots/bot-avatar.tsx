"use client";
import { memo, useLayoutEffect, useRef } from 'react';
import type { Bot } from './single-thread-contract';
import { identityFromSeed, mountAvatar, type AvatarController, type Emotion, type BotColor } from './avatar-engine';
import './bot-avatar.css';
/** Keep the same SVG/controller as native work moves through reasoning/tools/idle.
 * Upstream scheduler suspends hidden/offscreen/reduced-motion animation. */
export const BotAvatar = memo(function BotAvatar({ bot, small = false, emotion, working, decorative = false }: { bot: Pick<Bot, 'id' | 'name' | 'status' | 'avatar'>; small?: boolean; emotion?: Emotion; working?: boolean; decorative?: boolean }) {
  const svg = useRef<SVGSVGElement>(null), controller = useRef<AvatarController | null>(null);
  const identity = bot.avatar ?? { ...identityFromSeed(bot.id), seed: bot.id };
  const active = working ?? bot.status === 'running';
  useLayoutEffect(() => {
    if (!svg.current) return;
    try { controller.current = mountAvatar(svg.current, { ...identityFromSeed(bot.id), seed: bot.id, playful: false, shadow: false, reducedMotion: 'system' }, { label: bot.name }); } catch {
      // Unsupported rendering retains the accessible static initials below.
      svg.current.replaceChildren();
      const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
      text.setAttribute("x", "64"); text.setAttribute("y", "76"); text.setAttribute("text-anchor", "middle"); text.setAttribute("font-size", "36"); text.setAttribute("fill", "#387451"); text.textContent = bot.name.trim().slice(0, 2).toUpperCase(); svg.current.appendChild(text);
    }
    return () => { controller.current?.destroy(); controller.current = null; };
  }, [bot.id, bot.name]);
  useLayoutEffect(() => {
    controller.current?.setOptions({ shape: identity.shape, color: identity.color as BotColor, seed: identity.seed, state: active ? 'working' : 'idle', emotion: emotion ?? 'auto', playful: false, intensity: small ? .55 : .8 });
  }, [identity.shape, identity.color, identity.seed, active, emotion, small]);
  return <span className={`bot-avatar-engine${small ? ' small' : ''}`} aria-hidden={decorative || undefined}><svg ref={svg} viewBox="0 0 128 128" role="img" aria-label={bot.name} /></span>;
});
