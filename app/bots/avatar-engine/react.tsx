'use client';
import { forwardRef, useEffect, useImperativeHandle, useRef, type SVGProps } from 'react';
import { type AvatarConfig, type AvatarEmote } from './config.js';
import { mountAvatar, type AvatarController } from './renderer.js';
import { type AvatarLogger } from './engine.js';
export interface BotAvatarProps
  extends Partial<AvatarConfig>, Omit<SVGProps<SVGSVGElement>, keyof AvatarConfig | 'onChange'> {
  size?: number | string;
  label?: string;
  debug?: boolean;
  onEvent?: AvatarLogger;
}
export interface BotAvatarHandle {
  toSVG(): string | undefined;
  play(emote: AvatarEmote): boolean;
}
/** Renders once per prop change. Animation updates SVG attributes outside React. */
export const BotAvatar = forwardRef<BotAvatarHandle, BotAvatarProps>(function BotAvatar(
  {
    shape,
    color,
    state,
    emotion,
    motion,
    seed,
    intensity,
    speed,
    transitionMs,
    paused,
    reducedMotion,
    shadow,
    playful,
    size = 64,
    label,
    debug = false,
    onEvent,
    ...svgProps
  },
  forwardedRef,
) {
  const svg = useRef<SVGSVGElement>(null);
  const controller = useRef<AvatarController | null>(null);
  const eventRef = useRef(onEvent);
  const debugRef = useRef(debug);
  eventRef.current = onEvent;
  debugRef.current = debug;
  const options = {
    shape,
    color,
    state,
    emotion,
    motion,
    seed,
    intensity,
    speed,
    transitionMs,
    paused,
    reducedMotion,
    shadow,
    playful,
  };
  const initial = useRef({ options, label });
  useImperativeHandle(
    forwardedRef,
    () => ({
      toSVG: () => controller.current?.toSVG(),
      play: (emote) => controller.current?.play(emote) ?? false,
    }),
    [],
  );
  useEffect(() => {
    if (!svg.current) return;
    controller.current = mountAvatar(svg.current, initial.current.options, {
      label: initial.current.label,
      onEvent: (event) => {
        if (debugRef.current) console.debug('[littlebot]', event);
        eventRef.current?.(event);
      },
    });
    return () => {
      controller.current?.destroy();
      controller.current = null;
    };
  }, []);
  useEffect(() => {
    controller.current?.setOptions(options);
  }, [
    shape,
    color,
    state,
    emotion,
    motion,
    seed,
    intensity,
    speed,
    transitionMs,
    paused,
    reducedMotion,
    shadow,
    playful,
  ]);
  useEffect(() => {
    controller.current?.setLabel(label);
  }, [label]);
  return (
    <svg
      ref={svg}
      width={size}
      height={size}
      viewBox="0 0 128 128"
      role="img"
      aria-label={label ?? 'Bot avatar'}
      {...svgProps}
    />
  );
});
