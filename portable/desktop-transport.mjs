import { boundedFrame, id } from './protocol.mjs';

const LIMIT = 128 * 1024;
const END_REASONS = new Set(['desktop-disabled', 'node-connection-changed', 'control-snapshot-unavailable', 'bot-unavailable',
  'viewer-close', 'input-byte-limit', 'input-frame-limit', 'node-output-buffer-limit', 'output-send-failed',
  'runtime-message-failed', 'runtime-maintenance', 'node-disconnected', 'scope-reconcile-failed', 'viewer-limit', 'transport-ended']);
const failure = (desktopReason) => Object.assign(Error('Linux desktop scope is unavailable or changed.'), { outcome: 'not-sent', ...(desktopReason ? { desktopReason } : {}) });
export const DESKTOP_READS = new Set(['desktop.status', 'desktop.preview', 'desktop.open']);
export const DESKTOP_MUTATIONS = new Set(['desktop.start', 'desktop.stop', 'desktop.delete', 'desktop.browserPolicy', 'desktop.browserRelease', 'desktop.browserProtect', 'desktop.browserReopen']);
export function desktopCapable(node, socket) {
  const enrolled = JSON.parse(node.hello);
  return enrolled.platform === 'linux' && enrolled.capabilities?.desktop === true &&
    socket?.readyState === 1 && socket.portableHello?.platform === 'linux' && socket.portableHello.capabilities?.desktop === true;
}
function dataBytes(data) {
  if (typeof data !== 'string' || data.length > Math.ceil(LIMIT / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw failure();
  const bytes = Buffer.from(data, 'base64');
  if (bytes.length > LIMIT || bytes.toString('base64') !== data) throw failure();
  return bytes;
}

const HUB_END_REASONS = new Set(['session-expired', 'session-invalid', 'parent-disconnected', 'placement-changed', 'node-unavailable',
  'viewer-frame-rejected', 'viewer-output-unavailable', 'node-frame-rejected', 'node-disconnected', 'hub-closing']);
const QUIET_HUB_REASONS = new Set(['viewer-close', 'viewer-socket-closed', 'node-closed']);

// Viewer traffic is ephemeral. Never journal credentials, RFB input, or a
// replacement open/input after an ambiguous disconnect.
export class HubDesktopTransport {
  constructor({ store, connections, parent }) {
    Object.assign(this, { store, connections, parent });
    this.channels = new Map();
  }
  scope(c) {
    const p = this.store.placement(c.owner, c.botId), n = this.store.node(p.node_id), ws = this.connections.get(p.node_id);
    if (p.node_id !== c.nodeId || p.epoch !== c.epoch || ws !== c.nodeSocket) throw failure('placement-changed');
    if (!desktopCapable(n, ws)) throw failure('node-unavailable');
    if (c.expiresAt <= Date.now()) throw failure('session-expired');
    if (!c.valid()) throw failure('session-invalid');
    if (!this.parent(c.owner, c.parentId)) throw failure('parent-disconnected');
    return ws;
  }
  open({ owner, clientId, parentId, botId, token, expiresAt, send, close, valid=()=>true }) {
    if (![clientId, parentId, botId].every(id) || clientId === parentId || !/^[a-f0-9]{64}$/.test(token ?? '') ||
      !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() || this.channels.has(clientId) || this.channels.size >= 64) throw failure();
    const p = this.store.placement(owner, botId), nodeSocket = this.connections.get(p.node_id);
    if ([...this.channels.values()].filter(c => c.nodeId === p.node_id).length >= 8) throw failure();
    const c = { owner, clientId, parentId, botId, expiresAt, send, close, valid, nodeId: p.node_id, epoch: p.epoch, nodeSocket, openedAt: performance.now() };
    this.scope(c); this.channels.set(clientId, c);
    try { nodeSocket.send(boundedFrame({ type: 'desktop-request', event: 'open', clientId, parentId, botId, epoch: p.epoch, token })); }
    catch { this.end(clientId, true, 'node-unavailable'); throw failure(); }
  }
  frame(clientId, message) {
    const c = this.channels.get(clientId); if (!c) throw failure();
    try {
      const ws = this.scope(c), { event } = message;
      if (!['data', 'ping', 'close', 'control'].includes(event)) throw failure();
      if (event === 'data') dataBytes(message.data);
      ws.send(boundedFrame({ type: 'desktop-request', event, clientId, botId: c.botId, epoch: c.epoch,
        ...(event === 'data' ? { data: message.data } : {}), ...(event === 'control' ? { exclusive: message.exclusive === true } : {}) }));
      if (event === 'close') this.end(clientId, false, 'viewer-close');
    } catch (error) { this.end(clientId, true, error?.desktopReason ?? 'viewer-frame-rejected'); throw failure(); }
  }
  receive(nodeId, socket, message) {
    const c = this.channels.get(message.clientId); if (!c) return;
    // Only a frame from another node or scope is a node protocol fault.
    if (c.nodeId !== nodeId || c.nodeSocket !== socket || c.botId !== message.botId || c.epoch !== message.epoch) throw failure();
    try { this.scope(c); } catch (error) { this.end(c.clientId, true, error?.desktopReason); return; }
    let reason = 'node-frame-rejected';
    try {
      if (message.event === 'data') { const bytes = dataBytes(message.data); reason = 'viewer-output-unavailable'; c.send(bytes); }
      else if (['ready', 'closed', 'control'].includes(message.event)) {
        if (message.password !== undefined && (message.event !== 'ready' || typeof message.password !== 'string' || message.password.length > 512) ||
          message.error !== undefined && (typeof message.error !== 'string' || message.error.length > 512) ||
          message.exclusive !== undefined && typeof message.exclusive !== 'boolean') throw failure();
        reason = 'viewer-output-unavailable';
        c.send({ type: 'desktop', event: message.event,
          ...(message.password !== undefined ? { password: message.password } : {}),
          ...(message.error !== undefined ? { error: message.error } : {}),
          ...(message.exclusive !== undefined ? { exclusive: message.exclusive } : {}) });
        if (message.event === 'closed') this.end(c.clientId, false, 'node-closed');
      } else throw failure();
    } catch {
      // A slow or broken viewer ends only that viewer. Rethrowing made the
      // gateway close the node socket and drop every bot with it.
      this.end(c.clientId, true, reason);
    }
  }
  end(clientId, notify = true, reason = 'viewer-socket-closed') {
    const c = this.channels.get(clientId); if (!c) return;
    this.channels.delete(clientId);
    // Fixed categories and timing only; never tickets, passwords or frames.
    if (!QUIET_HUB_REASONS.has(reason)) try { console.warn('[desktop-transport]', JSON.stringify({
      side: 'hub', reason: HUB_END_REASONS.has(reason) ? reason : 'transport-ended', botId: c.botId, epoch: c.epoch,
      elapsedMs: Math.round(performance.now() - c.openedAt),
    })); } catch { /* Diagnostic failure must not prevent channel disposal. */ }
    if (notify && this.connections.get(c.nodeId) === c.nodeSocket && c.nodeSocket.readyState === 1) {
      try { c.nodeSocket.send(boundedFrame({ type: 'desktop-request', event: 'close', clientId, botId: c.botId, epoch: c.epoch })); } catch { /* no replay */ }
    }
    try { c.close(); } catch { /* channel is already disposed */ }
  }
  disconnectNode(socket) { for (const c of [...this.channels.values()]) if (c.nodeSocket === socket) this.end(c.clientId, false, 'node-disconnected'); }
  disconnectParent(parentId) { for (const c of [...this.channels.values()]) if (c.parentId === parentId) this.end(c.clientId, true, 'parent-disconnected'); }
  disconnectBot(botId) { for (const c of [...this.channels.values()]) if (c.botId === botId) this.end(c.clientId, true, 'placement-changed'); }
  close() { for (const c of [...this.channels.values()]) this.end(c.clientId, true, 'hub-closing'); }
}

export class AgentDesktopTransport {
  constructor({ runtime, journal, currentSocket }) {
    Object.assign(this, { runtime, journal, currentSocket }); this.channels = new Map(); this.retired = new Set();
  }
  scope(c) {
    // A synchronous scope rejection is caught by the outer node handler,
    // which closes its socket. Retain the first cause on this ephemeral
    // channel so disconnect() does not mask it as a generic node disconnect.
    const reject = reason => { c.scopeFailureReason ??= reason; throw failure(reason); };
    if (!this.runtime.desktops) reject('desktop-disabled');
    if (this.currentSocket() !== c.socket || c.socket.readyState !== 1) reject('node-connection-changed');
    if (!this.journal.currentControl({ bot_id: c.botId, epoch: c.epoch })) reject('control-snapshot-unavailable');
    const bot = this.runtime.store.bot(c.botId);
    try { this.runtime.desktops.assertBot(bot); } catch { reject('bot-unavailable'); }
    return bot;
  }
  message(socket, m) {
    if (!id(m.clientId) || !id(m.botId) || !Number.isSafeInteger(m.epoch) || !['open', 'close', 'ping', 'control', 'data'].includes(m.event)) throw failure();
    let c = this.channels.get(m.clientId);
    if (m.event === 'open') {
      if (c || [...this.retired].some(old=>old.clientId===m.clientId) ||
        !id(m.parentId) || m.parentId === m.clientId || !/^[a-f0-9]{64}$/.test(m.token ?? '')) throw failure();
      c = { socket, botId: m.botId, epoch: m.epoch, clientId: m.clientId, queue: [], draining: false, bytes: 0, pending: 0, openedAt: performance.now() };
      // The hub counts only live viewers; this side also counts retired ones
      // whose work is still settling. Over the cap, refuse this viewer only:
      // a throw here would close the shared node connection.
      const full = this.channels.size + this.retired.size >= 8;
      this.channels.set(m.clientId, c);
      if (full) { void this.end(c, 'viewer-limit').catch(() => {}); return; }
      if (!this.admitted(c)) return;
    }
    if (!c) return;
    if (c.socket !== socket || c.botId !== m.botId || c.epoch !== m.epoch) throw failure();
    // Closing is always allowed to dispose this exact old channel after an
    // epoch/connection change; it never grants access to another session.
    if (m.event === 'close') return this.end(c, 'viewer-close');
    if (!this.admitted(c)) return;
    const bytes = m.event === 'data' ? dataBytes(m.data).length : 0;
    if (c.bytes + bytes > 2 * 1024 * 1024) return this.end(c, 'input-byte-limit');
    // Bounds input waiting behind unfinished open/control/ping work. Frames
    // that can be applied immediately never count against it.
    if (c.queue.length >= 64) return this.end(c, 'input-frame-limit');
    c.bytes += bytes; c.pending++; c.queue.push({ m, bytes });
    return this.drain(c);
  }
  // A scope change ends only this viewer. Throwing here would close the shared
  // node connection and with it every bot's traffic.
  admitted(c) {
    try { this.scope(c); return true; }
    catch (error) { void this.end(c, error?.desktopReason ?? 'scope-reconcile-failed').catch(() => {}); return false; }
  }
  // Frames apply in arrival order. A data frame reaches the desktop's TCP
  // stream synchronously when it runs, so later frames need not wait for its
  // promise; only open/control/ping hold the frames behind them. Previously
  // every frame waited several promise turns for the one before it, and a
  // burst of ~100 already-received pointer frames (one network read after an
  // event-loop pause) overran the 64-frame bound and ended the viewer with
  // "Desktop transport ended." although no work was slow.
  drain(c) {
    if (c.draining) return c.drained;
    c.draining = true;
    return c.drained = (async () => {
      try {
        while (c.queue.length) {
          const { m, bytes } = c.queue.shift();
          const done = (this.channels.get(c.clientId) === c ? this.run(c, m) : Promise.resolve())
            .catch(error => this.end(c, error?.desktopReason ?? (error?.maintenance ? 'runtime-maintenance' : 'runtime-message-failed')))
            .finally(() => { c.bytes -= bytes; c.pending--; if(!c.pending)this.retired.delete(c); });
          if (m.event !== 'data') await done;
        }
      } finally { c.draining = false; }
    })();
  }
  async run(c, m) {
    const socket = c.socket;
    this.scope(c);
    const send = value => {
      try {
        if (this.channels.get(c.clientId) !== c) return;
        this.scope(c);
        if (socket.bufferedAmount > 8 * 1024 * 1024) throw failure('node-output-buffer-limit');
        socket.send(boundedFrame({ ...value, type: 'desktop-response', botId: c.botId, epoch: c.epoch }));
        if (value.event === 'closed') this.channels.delete(c.clientId);
      } catch (error) { void this.end(c, error?.desktopReason ?? 'output-send-failed'); }
    };
    const work = () => this.runtime.maintenance.track(() => this.runtime.desktops.message({ ...m, type: 'desktop' }, send));
    if (m.event === 'open') await this.runtime.maintenance.admit(work); else await work();
    if (this.channels.get(c.clientId) === c) this.scope(c);
    else await this.runtime.desktops.end(c.clientId, 'Desktop connection ended during open.');
  }
  async end(c, reason = 'transport-ended') {
    if (this.channels.get(c.clientId) === c) {
      this.channels.delete(c.clientId);
      reason = c.scopeFailureReason ?? reason;
      // Fixed categories and numeric counters only: never log tickets,
      // passwords, RFB bytes, page contents, or arbitrary exception text.
      if (reason !== 'viewer-close') try { console.warn('[desktop-transport]', JSON.stringify({
        reason: END_REASONS.has(reason) ? reason : 'transport-ended', botId: c.botId, epoch: c.epoch,
        elapsedMs: Math.round(performance.now() - c.openedAt), pendingFrames: c.pending,
        pendingBytes: c.bytes, bufferedBytes: c.socket.bufferedAmount,
      })); } catch { /* Diagnostic failure must not prevent channel disposal. */ }
      if(c.pending)this.retired.add(c);
      if (this.currentSocket() === c.socket && c.socket.readyState === 1) {
        try { c.socket.send(boundedFrame({ type: 'desktop-response', event: 'closed', clientId: c.clientId, botId: c.botId, epoch: c.epoch, error: 'Desktop transport ended.' })); } catch { /* no replay */ }
      }
    }
    await this.runtime.desktops?.end(c.clientId, 'Desktop transport ended.');
  }
  async disconnect(socket) {
    await Promise.all([...this.channels.values()].filter(c => c.socket === socket).map(c => this.end(c, 'node-disconnected')));
  }
  async reconcile() {
    await Promise.all([...this.channels.values()].map(c => { try { this.scope(c); } catch (error) { return this.end(c, error?.desktopReason ?? 'scope-reconcile-failed'); } }));
  }
}
