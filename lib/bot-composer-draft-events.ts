/** Portable site runs one Node process. Writes notify connected clients after
 * persistence; reconnect always reads SQLite. No periodic draft reads. */
type Listener = () => void;
const symbol = Symbol.for('dawar.bot-composer-draft-events.v1');
const root = globalThis as typeof globalThis & { [symbol]?: Map<string, Set<Listener>> };
const listeners = root[symbol] ??= new Map<string, Set<Listener>>();
const key = (owner: string, botId: string) => JSON.stringify([owner, botId]);
export function notifyComposerDraft(owner: string, botId: string) {
  for (const listener of listeners.get(key(owner, botId)) ?? []) listener();
}
export function composerDraftEvents(owner: string, botId: string, signal: AbortSignal) {
  const encoder = new TextEncoder(); let stop = () => {};
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const identity = key(owner, botId), group = listeners.get(identity) ?? new Set<Listener>();
      const emit = () => controller.enqueue(encoder.encode('event: changed\ndata: draft\n\n'));
      const heartbeat = setInterval(() => controller.enqueue(encoder.encode(': keepalive\n\n')), 15_000);
      // A bounded stream reacquires the authenticated session on reconnect.
      const lifetime = setTimeout(() => stop(), 55_000);
      let stopped = false;
      stop = () => {
        if (stopped) return; stopped = true;
        clearInterval(heartbeat); clearTimeout(lifetime); group.delete(emit);
        if (!group.size) listeners.delete(identity);
        signal.removeEventListener('abort', stop);
        try { controller.close(); } catch { /* already cancelled */ }
      };
      group.add(emit); listeners.set(identity, group); signal.addEventListener('abort', stop, { once: true });
      if (signal.aborted) return stop();
      emit();
    },
    cancel() { stop(); },
  });
}
