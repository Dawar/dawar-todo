/** The portable site has one Node process. Invalidation follows persistence;
 * bounded streams reauthenticate and reread durable state on reconnect. */
type Listener = () => void;
const symbol = Symbol.for('dawar.bot-settings-events.v1');
const root = globalThis as typeof globalThis & { [symbol]?: Map<string, Set<Listener>> };
const listeners = root[symbol] ??= new Map<string, Set<Listener>>();
const key = (namespace: string, owner: string, scope: string) => JSON.stringify([namespace, owner, scope]);
export function notifyBotSetting(namespace: string, owner: string, scope = '') {
  for (const listener of listeners.get(key(namespace, owner, scope)) ?? []) listener();
}
export function botSettingEvents(namespace: string, owner: string, scope: string, signal: AbortSignal) {
  const encoder = new TextEncoder(); let stop = () => {};
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const identity = key(namespace, owner, scope), group = listeners.get(identity) ?? new Set<Listener>();
      const emit = () => controller.enqueue(encoder.encode('event: changed\ndata: changed\n\n'));
      const heartbeat = setInterval(() => controller.enqueue(encoder.encode(': keepalive\n\n')), 15_000);
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
