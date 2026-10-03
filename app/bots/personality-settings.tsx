"use client";
import { useLayoutEffect, useMemo, useSyncExternalStore } from 'react';
import type { Bot, BotSnapshot } from './single-thread-contract';
import { botsClient as client } from './client';
import { getComposerSettings } from './composer-settings-controller';
import { PALETTE, SHAPES, identityFromSeed, resolveColor, type BotColor } from './avatar-engine';
import { BotAvatar } from './bot-avatar';
export function PersonalitySettings({ bot, snapshot, online }: { bot: Bot; snapshot: BotSnapshot; online: boolean }) {
  const owner = client.owner;
  const controller = useMemo(() => getComposerSettings(owner, bot.id), [owner, bot.id]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useLayoutEffect(() => controller.observe(bot, snapshot, online), [controller, bot, snapshot, online]);
  useLayoutEffect(() => controller.attach(), [controller]);
  const values = controller.displayed(bot), avatar = values.avatar ?? bot.avatar ?? identityFromSeed(bot.id);
  return <><section className="bots-personality"><h3>A familiar face</h3><div className="bots-personality-preview"><BotAvatar bot={{ ...bot, avatar: { ...avatar, version: 1, seed: bot.avatar?.seed ?? bot.id } }} /><p>A little character for {bot.name}.<br />The same face wherever you work together.</p></div>
    <div className="bots-avatar-shapes" role="group" aria-label="Avatar shape">{SHAPES.map(shape => <button type="button" key={shape} aria-pressed={avatar.shape === shape} disabled={!online} onClick={() => controller.edit({ avatar: { shape, color: avatar.color } })}>{shape}</button>)}</div>
    <div className="bots-avatar-colors" role="group" aria-label="Avatar color">{Object.entries(PALETTE).map(([name, color]) => <button type="button" key={name} style={{ background: color }} aria-label={name} aria-pressed={resolveColor(avatar.color as BotColor) === color} disabled={!online} onClick={() => controller.edit({ avatar: { shape: avatar.shape, color: name } })} />)}</div>
    <label className="bots-avatar-custom">Custom color<input type="color" aria-label="Custom avatar color" value={resolveColor(avatar.color as BotColor)} disabled={!online} onChange={event => controller.edit({ avatar: { shape: avatar.shape, color: event.target.value } })} /></label>
  </section>{snapshot.capabilities?.messageBursts === 1 && <label className="bots-burst-preference"><span>Message bursts<small>Send a few thoughts together. Keep typing to give yourself a little more time.</small></span><select aria-label="Message burst quiet time" disabled={!online} value={values.burstQuietSeconds ?? 3} onChange={event => controller.edit({ burstQuietSeconds: Number(event.target.value) as 0 | 2.5 | 3 | 8 | 15 })}><option value="0">Off</option><option value="2.5">2.5 seconds</option><option value="3">3 seconds</option><option value="8">8 seconds</option><option value="15">15 seconds</option></select></label>}
    {(state.error || state.storageError || state.confirmationError) && <p role="alert">{state.storageError || state.error || state.confirmationError} Review the saved change below your conversation.</p>}
  </>;
}
