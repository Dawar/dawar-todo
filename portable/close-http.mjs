// Closes a server once its owner has PROVEN the drain idle. `server.close()`
// alone waits for every client to hang up: the public front keeps pooled
// keep-alive sockets busy (each new request resets their idle timer) and
// streamed responses never end, so a stopping backend sat in stop-sigterm
// until systemd's deadline. Idle sockets close immediately and again as soon
// as any in-flight response finishes; WebSockets get a close frame; whatever
// remains after the grace period is destroyed. Only call this after the
// maintenance drain/claim proof, never as a substitute for it.
export function closeHttpServer(server, { graceMs = 2000, sockets = () => [] } = {}) {
  return new Promise(resolve => {
    let done = false;
    const finish = () => { if (done) return; done = true; clearInterval(idle); clearTimeout(force); resolve(); };
    const each = action => { for (const ws of sockets()) try { action(ws); } catch { /* already closed */ } };
    server.close(finish);
    server.closeIdleConnections?.();
    each(ws => ws.close(1001, 'Service restarting'));
    const idle = setInterval(() => server.closeIdleConnections?.(), 50);
    const force = setTimeout(() => { each(ws => ws.terminate()); server.closeAllConnections?.(); }, graceMs);
    idle.unref?.(); force.unref?.();
  });
}
