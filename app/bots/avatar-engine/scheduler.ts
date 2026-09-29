/** One animation frame loop shared by all visible avatars. Zero work when there are no subscribers. */
type FrameCallback = (dt: number) => void;
const subscribers = new Set<FrameCallback>();
let frame: number | null = null;
let previous: number | null = null;
function tick(now: number) {
  frame = null;
  const dt = previous === null ? 0 : Math.min((now - previous) / 1000, 0.05);
  previous = now;
  for (const callback of subscribers) callback(dt);
  if (subscribers.size) frame = requestAnimationFrame(tick);
  else previous = null;
}
export function subscribe(callback: FrameCallback): () => void {
  subscribers.add(callback);
  if (frame === null) frame = requestAnimationFrame(tick);
  return () => {
    subscribers.delete(callback);
    if (!subscribers.size) {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      previous = null;
    }
  };
}
export function getSchedulerStats(): { activeAvatars: number; running: boolean } {
  return { activeAvatars: subscribers.size, running: frame !== null };
}
