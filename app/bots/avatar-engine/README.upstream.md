# @dawartodo/bot-avatar

A dependency-free TypeScript engine for continuous, expressive flat SVG avatars, with an optional React 18/19 adapter. This package is local and unpublished.

```tsx
'use client';
import { BotAvatar } from '@dawartodo/bot-avatar/react';
<BotAvatar seed="thread-123" shape="circle" color="lilac" state="working" size={40} />;
```

## Configuration

| Property        | Values / range                                                                                                | Default     |
| --------------- | ------------------------------------------------------------------------------------------------------------- | ----------- |
| `shape`         | `circle`, `square`, `triangle`, `cloud`, `star`, `hexagon`                                                    | `circle`    |
| `color`         | `lilac`, `mint`, `coral`, `sky`, `butter`, `graphite`, or `#RRGGBB`                                           | `lilac`     |
| `emotion`       | `auto`, `resting`, `curious`, `thinking`, `sleepy`, `focused`, `determined`, `frustrated`, `testing`, `happy` | `auto`      |
| `state`         | `idle`, `working`                                                                                             | `idle`      |
| `motion`        | `organic`, `springy`, `precise`                                                                               | `organic`   |
| `seed`          | string or finite number                                                                                       | `littlebot` |
| `intensity`     | 0–1                                                                                                           | 0.6         |
| `speed`         | 0.25–2                                                                                                        | 1           |
| `transitionMs`  | 150–2000                                                                                                      | 700         |
| `paused`        | boolean                                                                                                       | false       |
| `reducedMotion` | `system`, `always`, `never`                                                                                   | `system`    |
| `playful`       | boolean; occasional idle spins                                                                                | true        |
| `shadow`        | boolean                                                                                                       | false       |

`transitionMs` is approximate spring settling time, not a hard deadline. At zero intensity automatic behavior settles to the activity’s initial expression; body motion and gaze stop, but the avatar can still blink. `paused` freezes the current animation clock. Editing visual options while paused settles them to a static pose. `reducedMotion="always"` disables all movement but keeps the state's expression. Use `never` only for an intentional application override.

`BotAvatar` also accepts `size` (default 64), an accessible `label`, ordinary SVG attributes, `debug`, and `onEvent`. It exposes `toSVG()` through a `BotAvatarHandle` ref; this exports a still snapshot, not an animation. `size` is the whole SVG box, including motion clearance. The colored body occupies roughly 60–65% of that box.

## Expressions and playful moments

Activity (`state`) and expression (`emotion`) are independent. `emotion="auto"` runs the selected activity's behavior recipe. Idle wanders between resting, curiosity, thinking, sleepiness, and occasional delight, with seeded weighted choices, varied holds, and smooth handoffs. Sleepiness wakes into curiosity; delight settles back into rest. Working follows focus → determination → frustration → rethinking → testing → delight, over roughly 12–13 seconds at normal speed. Its anger uses tight slanted eyes, body compression and short shakes; happiness morphs the eyes into upward crescents and adds a bounce.

Pin any expression in either activity with `emotion="frustrated"`, then return to automatic behavior with `emotion="auto"`. Overrides smoothly blend from the current expression, including when interrupted. Automatic behavior continues underneath an override and resumes smoothly. This is an expressive animation: delight does not change the activity or report task completion. An integration can use real task events to choose expressions instead.

```ts
avatar.setOptions({ state: 'working', emotion: 'auto' });
avatar.setOptions({ emotion: 'frustrated' }); // e.g. a retry
avatar.setOptions({ emotion: 'happy' }); // e.g. a successful test
avatar.setOptions({ emotion: 'auto' }); // return to the activity recipe
```

Large glossy eyes retain seeded look-and-linger glances. The catchlights are fixed-size circles: eye shape, squint, blink, and body squash never distort them. Self-contained clipping paths hide reflections behind eyelids and keep the turning face inside every body shape.

`playful` defaults to `true`. Organic and Springy avatars occasionally do a hop-and-spin while idle, after seed-staggered intervals of roughly 12–24 animation seconds, when the automatic expression is resting, curious, or happy. Explicit emotion overrides suppress automatic spins. Set `playful={false}` to disable automatic spins; Precise does not auto-spin. A manual spin is available in every style:

```ts
controller.play('spin'); // or avatarRef.current?.play('spin') with the React handle
```

`play()` returns false if paused, reduced motion is active, or a spin is already playing. Spins run over the existing idle/working motion and preserve smooth state changes. Pausing freezes the spin; switching to reduced motion cancels it. Hidden/offscreen avatars freeze their local clock as usual. There is no spin state to persist in application data.

## Plain browser JavaScript

```ts
import { mountAvatar } from '@dawartodo/bot-avatar';
const controller = mountAvatar(
  svgElement,
  { seed: 'thread-123' },
  {
    label: 'Planning bot',
    onEvent: (event) => console.debug('[avatar]', event),
  },
);
controller.setOptions({ state: 'working' });
controller.setLabel('Planning bot is working');
const snapshot = controller.toSVG();
controller.destroy();
```

Each mount owns the SVG's children until `destroy()` restores the prior children and attributes. Use one controller per SVG. Destroy it when the view unmounts. The React wrapper handles that automatically, including Strict Mode cleanup.

## Headless engine

```ts
import { AvatarEngine } from '@dawartodo/bot-avatar';
const engine = new AvatarEngine({ seed: 'thread-123' });
engine.setOptions({ state: 'working' });
const frame = engine.step(1 / 60); // delta in seconds
// frame: pose, path, color, eyeColor, faceOffsetY, energy, emotion
```

The headless engine does not read system preferences. Pass `true` as the second argument to `step(delta, reduced)` to request a static frame, or configure `reducedMotion: 'always'`. Call `step` regularly; deltas are clamped to 50 ms to avoid motion jumps after stalls. Browser renderer users do not need to handle clocks themselves.

Exports also include `PALETTE`, `SHAPES`, `STATES`, `MOTION_STYLES`, `EMOTIONS`, `STATE_BEHAVIORS`, `DEFAULT_CONFIG`, `identityFromSeed`, `normalizeConfig`, `parseConfig`, `resolveColor`, and `getSchedulerStats`. Configuration validation throws `TypeError` for invalid known values; JSON parsing ignores unknown fields and fills missing values from defaults. Store only public bot identity/configuration in shareable presets.

## Diagnostics

Events include `created`, `updated`, `transition-start`, `transition-settled`, `visibility`, `motion-preference`, `emote-start`, `emote-complete`, `emote-skipped`, `emotion-change`, and `destroyed`. Payloads contain the public seed, timestamp, and relevant configuration or changed fields. `emotion-change` includes the previous/new expression, activity, automatic/override mode, and local animation time. It is emitted only when the dominant expression changes. Logging is opt-in and event-based. `getSchedulerStats()` reports active subscribers and whether the shared frame loop is running. Motion updates never log a line per frame.

## Extension boundary

Keep the public `state`, `emotion`, and one-shot `play(emote)` layers separate. The shipped catalog is typed, not an open string namespace: unsupported names fail validation instead of silently rendering an idle face.

- Add future activities in `STATE_BEHAVIORS` in `behaviors.ts`, using a sequence or weighted wandering recipe. `BotState`, `STATES`, validation, and the engine's spring blend derive from this catalog.
- Add an emotion to `EMOTIONS` and its numeric pose sampler in `motion.ts`. The exhaustive type check makes missing performances visible. Existing activities can reuse it, and a consumer can request it directly with `emotion`.
- Eye curvature, spacing, asymmetry, squint, gaze, and body posture are numeric pose channels. The SVG renderer interpolates them without knowing activity or emotion names. Keep catchlights separate from the deforming eyelid contour.
- Add a future one-shot action alongside `spin`; actions overlay the ongoing activity/emotion instead of becoming activity states.

These are source-level catalog extensions; the current package does not expose runtime plugin registration. A new activity only needs a studio label/control if it should also appear in the preview. Existing saved presets remain valid because omitted `emotion` defaults to `auto`.

## Packaging

From the parent workspace, run `npm run build`, then `npm pack --workspace @dawartodo/bot-avatar --pack-destination /tmp`. Install the generated tarball in the consuming app. No global CSS, Vite plugin, backend, or animation dependency is required. React 18 or 19 is needed only for `/react`.
