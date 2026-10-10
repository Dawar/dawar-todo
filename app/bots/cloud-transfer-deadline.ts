// Normal cloud files only. Secure-input transport has its own RAM-only lifecycle.
export const CLOUD_METADATA_DEADLINE_MS = 60_000;
export const CLOUD_UPLOAD_DEADLINE_MS = 120_000;
export const CLOUD_DOWNLOAD_IDLE_MS = 60_000;
export const CLOUD_DOWNLOAD_DEADLINE_MS = 10 * 60_000;

/** Bound both headers and body, even when a transport ignores its abort signal.
 * Each awaited operation removes its abort listener when it settles. */
export class CloudTransferDeadline {
  private controller = new AbortController();
  private totalTimer?: ReturnType<typeof setTimeout>;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private callerAborted = () => this.controller.abort(this.caller?.reason);
  get signal() { return this.controller.signal; }
  constructor(private totalMs: number, private timeout: () => Error,
    private caller?: AbortSignal, private idleMs?: number) {
    if (caller?.aborted) { this.callerAborted(); return; }
    caller?.addEventListener("abort", this.callerAborted, { once: true });
    this.totalTimer = setTimeout(() => this.controller.abort(this.timeout()), totalMs);
    this.progress();
  }
  progress() {
    if (!this.idleMs || this.signal.aborted) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.controller.abort(this.timeout()), this.idleMs);
  }
  run<T>(work: () => Promise<T>): Promise<T> {
    this.signal.throwIfAborted();
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (done: () => void) => {
        if (settled) return;
        settled = true; this.signal.removeEventListener("abort", aborted); done();
      };
      const aborted = () => finish(() => reject(this.signal.reason));
      this.signal.addEventListener("abort", aborted, { once: true });
      try { work().then(value => finish(() => resolve(value)), error => finish(() => reject(error))); }
      catch (error) { finish(() => reject(error)); }
    });
  }
  dispose() {
    clearTimeout(this.totalTimer); clearTimeout(this.idleTimer);
    this.caller?.removeEventListener("abort", this.callerAborted);
  }
}

export function cloudRetryDelay(signal: AbortSignal, milliseconds: number): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", aborted); };
    const aborted = () => { finish(); reject(signal.reason); };
    const timer = setTimeout(() => { finish(); resolve(); }, milliseconds);
    signal.addEventListener("abort", aborted, { once: true });
  });
}
