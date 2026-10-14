export const DESKTOP_CONTROL_ACK_MS = 45_000;

export type DesktopControlState = { exclusive: boolean | null; changing: boolean };

/** One pending control action on one authenticated desktop stream. The current
 * protocol has no action ID: replies are ordered on that stream, so uncertainty
 * retires it permanently rather than sending another toggle on the same stream. */
export class DesktopControl {
  private exclusive: boolean | null = null;
  private pending: { exclusive: boolean; deadline: number } | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private ended = false;

  constructor(
    private send: (exclusive: boolean) => void,
    private changed: (state: DesktopControlState) => void,
    private uncertain: (message: string) => void,
    private now: () => number = () => performance.now(),
  ) {}

  connected() {
    if (this.ended) return;
    // The authenticated ready frame opens a new shared bridge session.
    this.exclusive = false;
    this.publish();
  }

  request() {
    if (this.ended || this.pending || this.exclusive === null) return;
    const exclusive = !this.exclusive;
    this.pending = { exclusive, deadline: this.now() + DESKTOP_CONTROL_ACK_MS };
    this.timer = setTimeout(() => this.fail(
      "The control reply timed out. Control is unknown. Reconnect to recover; apps stay running.",
    ), DESKTOP_CONTROL_ACK_MS);
    this.publish();
    try { this.send(exclusive); }
    catch { this.fail("The control request could not be confirmed. Reconnect to recover; apps stay running."); }
  }

  reply(message: { exclusive?: unknown; error?: unknown }) {
    if (this.ended || !this.pending) return;
    // A backgrounded browser can deliver a reply before its suspended timer.
    if (this.now() >= this.pending.deadline) {
      this.fail("The control reply arrived too late. Control is unknown. Reconnect to recover; apps stay running.");
      return;
    }
    if (message.error) {
      this.fail("The control change was not confirmed. Reconnect to recover; apps stay running.");
      return;
    }
    if (message.exclusive !== this.pending.exclusive) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.exclusive = this.pending.exclusive;
    this.pending = null;
    this.publish();
  }

  end() {
    this.ended = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = null;
    this.exclusive = null;
    this.publish();
  }

  private fail(message: string) {
    if (this.ended) return;
    this.end();
    this.uncertain(message);
  }

  private publish() {
    this.changed({ exclusive: this.exclusive, changing: this.pending !== null });
  }
}
