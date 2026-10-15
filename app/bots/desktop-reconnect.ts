/** Server close reasons that mean the stream was lost, not refused. Anything
 * else (stopped desktop, exclusive control elsewhere, expired ticket, archived
 * bot) needs a person to decide, so it is never reopened automatically. */
const TRANSIENT_CLOSES = new Set([
  "Desktop transport ended.",
  "Desktop transport failed.",
  "Desktop disconnected.",
  "Desktop connection expired.",
  "Service disconnected.",
  "Desktop is starting. Reconnect in a moment.",
]);

export const desktopTransientClose = (error: unknown) =>
  typeof error === "string" && TRANSIENT_CLOSES.has(error);

export const DESKTOP_RECONNECT_LIMIT = 3;
/** A connection that stayed up this long earns a fresh set of attempts. */
export const DESKTOP_RECONNECT_STABLE_MS = 60_000;
/** How long an attempt waits for DawarTodo itself to come back online. */
export const DESKTOP_RECONNECT_WAIT_MS = 30_000;

/** Bounded automatic reopen of a viewer after transient transport loss. Each
 * attempt reopens from scratch (new desktop ticket, new signed-in session, new
 * stream), so no input is replayed and control always restarts shared. */
export class DesktopReconnect {
  private attempts = 0;
  private connectedAt: number | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private ready: () => boolean,
    private reopen: () => void,
    private gaveUp: () => void,
    private now: () => number = () => performance.now(),
    private schedule: (fn: () => void, ms: number) => ReturnType<typeof setTimeout> = (fn, ms) => setTimeout(fn, ms),
    private cancel: (timer: ReturnType<typeof setTimeout>) => void = (timer) => clearTimeout(timer),
  ) {}

  connected() {
    this.connectedAt = this.now();
  }

  /** Schedules one reopen; false when no automatic attempt remains. */
  failed(): boolean {
    this.stop();
    if (this.connectedAt !== null && this.now() - this.connectedAt >= DESKTOP_RECONNECT_STABLE_MS) this.attempts = 0;
    this.connectedAt = null;
    if (this.attempts >= DESKTOP_RECONNECT_LIMIT) return false;
    const delay = 1000 * 2 ** this.attempts++;
    let waited = 0;
    const attempt = () => {
      this.timer = undefined;
      if (this.ready()) this.reopen();
      else if ((waited += 1000) > DESKTOP_RECONNECT_WAIT_MS) this.gaveUp();
      else this.timer = this.schedule(attempt, 1000);
    };
    this.timer = this.schedule(attempt, delay);
    return true;
  }

  /** A person chose to reconnect, close or switch bots. */
  reset() {
    this.stop();
    this.attempts = 0;
    this.connectedAt = null;
  }

  stop() {
    if (this.timer !== undefined) this.cancel(this.timer);
    this.timer = undefined;
  }
}
