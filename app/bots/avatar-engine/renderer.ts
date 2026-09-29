import { AvatarEngine, type AvatarFrame, type AvatarLogger } from './engine.js';
import { type AvatarConfig, type AvatarEmote } from './config.js';
import { eyePath } from './motion.js';
import { subscribe } from './scheduler.js';
// Local compatibility: Cloudflare's Element.append declaration shadows DOM SVG.append.
const append = (parent: Node, ...nodes: Node[]) => { for (const node of nodes) parent.appendChild(node); };
const NS = 'http://www.w3.org/2000/svg';
function element<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attributes: Record<string, string> = {},
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  return node;
}
export interface MountOptions {
  label?: string;
  onEvent?: AvatarLogger;
  debug?: boolean;
}
export interface AvatarController {
  setOptions(options: Partial<AvatarConfig>): void;
  play(emote: AvatarEmote): boolean;
  getConfig(): AvatarConfig;
  setLabel(label?: string): void;
  /** Downloadable SVG snapshot at the current pose. No scripts or external assets. */
  toSVG(): string;
  destroy(): void;
}
/** Mount into a caller-owned SVG. Import is SSR-safe; call this only in a browser. */
export function mountAvatar(
  svg: SVGSVGElement,
  options: Partial<AvatarConfig> = {},
  mountOptions: MountOptions = {},
): AvatarController {
  const logger: AvatarLogger | undefined =
    mountOptions.onEvent || mountOptions.debug
      ? (event) => {
          if (mountOptions.debug) console.debug('[littlebot]', event);
          mountOptions.onEvent?.(event);
        }
      : undefined;
  const engine = new AvatarEngine(options, logger);
  const originalNodes = Array.from(svg.childNodes);
  const attributeNames = ['viewBox', 'role', 'aria-label', 'xmlns', 'data-emotion'];
  const originalAttributes = attributeNames.map((name) => [name, svg.getAttribute(name)] as const);
  svg.setAttribute('viewBox', '0 0 128 128');
  svg.setAttribute('xmlns', NS);
  svg.setAttribute('role', 'img');
  let label = mountOptions.label;
  let config = engine.getConfig();
  const updateLabel = () =>
    svg.setAttribute(
      'aria-label',
      label ?? `${config.shape} bot, ${config.state === 'working' ? 'working hard' : 'idle'}`,
    );
  updateLabel();
  const shadow = element('ellipse', {
    cx: '64',
    cy: '108',
    rx: '25',
    ry: '3',
    fill: '#262638',
    opacity: '.09',
  });
  const body = element('g', { 'data-part': 'body' });
  const shape = element('path', { 'data-part': 'shape' });
  const face = element('g', { 'data-part': 'face' });
  // The silhouette deforms independently. Fixed-size circular reflections are only
  // occluded by the eyelid, never stretched or tilted into the working expression.
  const definitions = element('defs');
  const avatarId = `littlebot-${crypto.randomUUID()}`;
  const faceClip = element('clipPath', { id: `${avatarId}-body`, clipPathUnits: 'userSpaceOnUse' });
  const faceBoundary = element('path');
  append(faceClip, faceBoundary);
  append(definitions, faceClip);
  const faceViewport = element('g', { 'clip-path': `url(#${avatarId}-body)` });
  const eyes = [-12, 12].map((x, index) => {
    const group = element('g', { 'data-part': 'eye' });
    const iris = element('path', { 'data-part': 'eye-shape' });
    const clipId = `${avatarId}-eye-${index}`;
    const clip = element('clipPath', { id: clipId, clipPathUnits: 'userSpaceOnUse' });
    const eyelid = element('path');
    append(clip, eyelid);
    append(definitions, clip);
    const shine = element('g', { 'data-part': 'eye-shine', 'clip-path': `url(#${clipId})` });
    append(shine,
      element('circle', {
        cx: '0',
        cy: '7',
        r: '2.6',
        fill: '#BCB7D9',
        opacity: '0.28',
      }),
      element('circle', { cx: '-2.6', cy: '-3.3', r: '2.5', fill: '#FFFFFF' }),
      element('circle', {
        cx: '3',
        cy: '3',
        r: '1.15',
        fill: '#FFFFFF',
        opacity: '0.9',
      }),
    );
    append(group, iris, shine);
    return { x, group, iris, eyelid, shine };
  });
  append(face, ...eyes.map((eye) => eye.group));
  append(faceViewport, face);
  append(body, shape, faceViewport);
  svg.replaceChildren(definitions, shadow, body);
  let destroyed = false;
  let unsubscribe: (() => void) | undefined;
  let onscreen = true;
  const media = window.matchMedia('(prefers-reduced-motion: reduce)');
  const reduced = () =>
    config.reducedMotion === 'always' || (config.reducedMotion === 'system' && media.matches);
  const paint = (frame: AvatarFrame) => {
    const p = frame.pose;
    svg.setAttribute('data-emotion', frame.emotion);
    const contour = eyePath(p.eyeCurve);
    body.setAttribute(
      'transform',
      `translate(${64 + p.x} ${61 + p.y}) rotate(${p.rotation}) scale(${p.scaleX} ${p.scaleY})`,
    );
    shape.setAttribute('d', frame.path);
    shape.setAttribute('fill', frame.color);
    faceBoundary.setAttribute('d', frame.path);
    const perspective = Math.max(0.08, Math.cos(p.faceTurn));
    // Cancel body squash for the face, so even breathing keeps catchlights circular.
    face.setAttribute(
      'transform',
      `translate(${p.gazeX * Math.cos(p.faceTurn) + Math.sin(p.faceTurn) * 32} ${p.gazeY + frame.faceOffsetY}) scale(${1 / p.scaleX} ${1 / p.scaleY})`,
    );
    face.setAttribute('opacity', String(p.faceOpacity));
    eyes.forEach(({ group, iris, eyelid, shine }, index) => {
      const side = index === 0 ? 1 : -1;
      iris.setAttribute('fill', frame.eyeColor);
      group.setAttribute(
        'transform',
        `translate(${-side * p.eyeSpacing * perspective} ${p.eyeLift * side})`,
      );
      const silhouette = `rotate(${p.eyeTilt * side}) scale(${(p.eyeWidth / 2) * perspective} ${(p.eyeHeight / 2) * (1 + p.eyeAsymmetry * side)})`;
      iris.setAttribute('d', contour);
      eyelid.setAttribute('d', contour);
      iris.setAttribute('transform', silhouette);
      eyelid.setAttribute('transform', silhouette);
      shine.setAttribute('opacity', String(Math.max(0, Math.min(1, (p.eyeOpen - 0.3) / 0.7))));
    });
    shadow.setAttribute('visibility', config.shadow ? 'visible' : 'hidden');
    shadow.setAttribute('rx', String(25 / p.shadowScale));
  };
  const render = (dt: number) => paint(engine.step(dt, reduced()));
  function reconcile() {
    const active = !destroyed && onscreen && !document.hidden && !config.paused && !reduced();
    if (active && !unsubscribe) unsubscribe = subscribe(render);
    if (!active && unsubscribe) {
      unsubscribe();
      unsubscribe = undefined;
    }
  }
  const onVisibility = () => {
    engine.log('visibility', { documentHidden: document.hidden, onscreen });
    reconcile();
  };
  const onMotion = () => {
    engine.log('motion-preference', { reduced: reduced() });
    render(0);
    reconcile();
  };
  const observer =
    typeof IntersectionObserver !== 'undefined'
      ? new IntersectionObserver(
          (entries) => {
            const entry = entries[0];
            if (!entry || entry.isIntersecting === onscreen) return;
            onscreen = entry.isIntersecting;
            onVisibility();
          },
          { rootMargin: '80px' },
        )
      : undefined;
  observer?.observe(svg);
  document.addEventListener('visibilitychange', onVisibility);
  media.addEventListener('change', onMotion);
  render(0);
  reconcile();
  return {
    play(emote) {
      if (destroyed) return false;
      return engine.play(emote, reduced());
    },
    setOptions(patch) {
      if (destroyed) return;
      const previous = config;
      engine.setOptions(patch);
      config = engine.getConfig();
      updateLabel();
      // A paused avatar freezes its clock, but remains editable in the studio.
      const edited = (
        ['shape', 'color', 'state', 'emotion', 'motion', 'seed', 'intensity', 'speed'] as const
      ).some((key) => previous[key] !== config[key]);
      if (config.paused && edited) paint(engine.step(0, true));
      else render(0);
      reconcile();
    },
    getConfig: () => engine.getConfig(),
    setLabel(next) {
      if (!destroyed) {
        label = next;
        updateLabel();
      }
    },
    toSVG() {
      return new XMLSerializer().serializeToString(svg);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      unsubscribe?.();
      observer?.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      media.removeEventListener('change', onMotion);
      engine.log('destroyed');
      svg.replaceChildren(...originalNodes);
      for (const [name, value] of originalAttributes) {
        if (value === null) svg.removeAttribute(name);
        else svg.setAttribute(name, value);
      }
    },
  };
}
