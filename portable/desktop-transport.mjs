import { boundedFrame, id } from './protocol.mjs';

const LIMIT = 128 * 1024;
const failure = () => Object.assign(Error('Linux desktop scope is unavailable or changed.'), { outcome: 'not-sent' });
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

// Viewer traffic is ephemeral. Never journal credentials, RFB input, or a
// replacement open/input after an ambiguous disconnect.
export class HubDesktopTransport {
  constructor({ store, connections, parent }) {
    Object.assign(this, { store, connections, parent });
    this.channels = new Map();
  }
  scope(c) {
    const p = this.store.placement(c.owner, c.botId), n = this.store.node(p.node_id), ws = this.connections.get(p.node_id);
    if (p.node_id !== c.nodeId || p.epoch !== c.epoch || ws !== c.nodeSocket || !desktopCapable(n, ws) ||
      c.expiresAt <= Date.now() || !c.valid() || !this.parent(c.owner, c.parentId)) throw failure();
    return ws;
  }
  open({ owner, clientId, parentId, botId, token, expiresAt, send, close, valid=()=>true }) {
    if (![clientId, parentId, botId].every(id) || clientId === parentId || !/^[a-f0-9]{64}$/.test(token ?? '') ||
      !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() || this.channels.has(clientId) || this.channels.size >= 64) throw failure();
    const p = this.store.placement(owner, botId), nodeSocket = this.connections.get(p.node_id);
    if ([...this.channels.values()].filter(c => c.nodeId === p.node_id).length >= 8) throw failure();
    const c = { owner, clientId, parentId, botId, expiresAt, send, close, valid, nodeId: p.node_id, epoch: p.epoch, nodeSocket };
    this.scope(c); this.channels.set(clientId, c);
    try { nodeSocket.send(boundedFrame({ type: 'desktop-request', event: 'open', clientId, parentId, botId, epoch: p.epoch, token })); }
    catch { this.end(clientId); throw failure(); }
  }
  frame(clientId, message) {
    const c = this.channels.get(clientId); if (!c) throw failure();
    try {
      const ws = this.scope(c), { event } = message;
      if (!['data', 'ping', 'close', 'control'].includes(event)) throw failure();
      if (event === 'data') dataBytes(message.data);
      ws.send(boundedFrame({ type: 'desktop-request', event, clientId, botId: c.botId, epoch: c.epoch,
        ...(event === 'data' ? { data: message.data } : {}), ...(event === 'control' ? { exclusive: message.exclusive === true } : {}) }));
      if (event === 'close') this.end(clientId, false);
    } catch { this.end(clientId); throw failure(); }
  }
  receive(nodeId, socket, message) {
    const c = this.channels.get(message.clientId); if (!c) return;
    if (c.nodeId !== nodeId || c.nodeSocket !== socket || c.botId !== message.botId || c.epoch !== message.epoch) throw failure();
    try { this.scope(c); } catch { this.end(c.clientId); return; }
    try {
      if (message.event === 'data') c.send(dataBytes(message.data));
      else if (['ready', 'closed', 'control'].includes(message.event)) {
        if (message.password !== undefined && (message.event !== 'ready' || typeof message.password !== 'string' || message.password.length > 512) ||
          message.error !== undefined && (typeof message.error !== 'string' || message.error.length > 512) ||
          message.exclusive !== undefined && typeof message.exclusive !== 'boolean') throw failure();
        c.send({ type: 'desktop', event: message.event,
          ...(message.password !== undefined ? { password: message.password } : {}),
          ...(message.error !== undefined ? { error: message.error } : {}),
          ...(message.exclusive !== undefined ? { exclusive: message.exclusive } : {}) });
        if (message.event === 'closed') this.end(c.clientId, false);
      } else throw failure();
    } catch { this.end(c.clientId); throw failure(); }
  }
  end(clientId, notify = true) {
    const c = this.channels.get(clientId); if (!c) return;
    this.channels.delete(clientId);
    if (notify && this.connections.get(c.nodeId) === c.nodeSocket && c.nodeSocket.readyState === 1) {
      try { c.nodeSocket.send(boundedFrame({ type: 'desktop-request', event: 'close', clientId, botId: c.botId, epoch: c.epoch })); } catch { /* no replay */ }
    }
    try { c.close(); } catch { /* channel is already disposed */ }
  }
  disconnectNode(socket) { for (const c of [...this.channels.values()]) if (c.nodeSocket === socket) this.end(c.clientId, false); }
  disconnectParent(parentId) { for (const c of [...this.channels.values()]) if (c.parentId === parentId) this.end(c.clientId); }
  disconnectBot(botId) { for (const c of [...this.channels.values()]) if (c.botId === botId) this.end(c.clientId); }
  close() { for (const c of [...this.channels.values()]) this.end(c.clientId); }
}

export class AgentDesktopTransport {
  constructor({ runtime, journal, currentSocket }) {
    Object.assign(this, { runtime, journal, currentSocket }); this.channels = new Map(); this.retired = new Set();
  }
  scope(c) {
    if (!this.runtime.desktops || this.currentSocket() !== c.socket || c.socket.readyState !== 1 ||
      !this.journal.currentControl({ bot_id: c.botId, epoch: c.epoch })) throw failure();
    const bot = this.runtime.store.bot(c.botId); this.runtime.desktops.assertBot(bot); return bot;
  }
  message(socket, m) {
    if (!id(m.clientId) || !id(m.botId) || !Number.isSafeInteger(m.epoch) || !['open', 'close', 'ping', 'control', 'data'].includes(m.event)) throw failure();
    let c = this.channels.get(m.clientId);
    if (m.event === 'open') {
      if (c || [...this.retired].some(old=>old.clientId===m.clientId) || this.channels.size+this.retired.size >= 8 ||
        !id(m.parentId) || m.parentId === m.clientId || !/^[a-f0-9]{64}$/.test(m.token ?? '')) throw failure();
      c = { socket, botId: m.botId, epoch: m.epoch, clientId: m.clientId, chain: Promise.resolve(), bytes: 0, pending: 0 };
      this.scope(c); this.channels.set(m.clientId, c);
    }
    if (!c) return;
    if (c.socket !== socket || c.botId !== m.botId || c.epoch !== m.epoch) throw failure();
    // Closing is always allowed to dispose this exact old channel after an
    // epoch/connection change; it never grants access to another session.
    if (m.event === 'close') return this.end(c);
    this.scope(c);
    const bytes = m.event === 'data' ? dataBytes(m.data).length : 0;
    if (c.bytes + bytes > 2 * 1024 * 1024 || c.pending >= 64) return this.end(c);
    c.bytes += bytes; c.pending++;
    const run = async () => {
      if (this.channels.get(c.clientId) !== c) return;
      this.scope(c);
      const send = value => {
        try {
          if (this.channels.get(c.clientId) !== c) return;
          this.scope(c);
          if (socket.bufferedAmount > 8 * 1024 * 1024) throw failure();
          socket.send(boundedFrame({ ...value, type: 'desktop-response', botId: c.botId, epoch: c.epoch }));
          if (value.event === 'closed') this.channels.delete(c.clientId);
        } catch { void this.end(c); }
      };
      const work = () => this.runtime.maintenance.track(() => this.runtime.desktops.message({ ...m, type: 'desktop' }, send));
      if (m.event === 'open') await this.runtime.maintenance.admit(work); else await work();
      if (this.channels.get(c.clientId) === c) this.scope(c);
      else await this.runtime.desktops.end(c.clientId, 'Desktop connection ended during open.');
    };
    c.chain = c.chain.then(run).catch(() => this.end(c)).finally(() => { c.bytes -= bytes; c.pending--; if(!c.pending)this.retired.delete(c); });
    return c.chain;
  }
  async end(c) {
    if (this.channels.get(c.clientId) === c) {
      this.channels.delete(c.clientId);
      if(c.pending)this.retired.add(c);
      if (this.currentSocket() === c.socket && c.socket.readyState === 1) {
        try { c.socket.send(boundedFrame({ type: 'desktop-response', event: 'closed', clientId: c.clientId, botId: c.botId, epoch: c.epoch, error: 'Desktop transport ended.' })); } catch { /* no replay */ }
      }
    }
    await this.runtime.desktops?.end(c.clientId, 'Desktop transport ended.');
  }
  async disconnect(socket) {
    await Promise.all([...this.channels.values()].filter(c => c.socket === socket).map(c => this.end(c)));
  }
  async reconcile() {
    await Promise.all([...this.channels.values()].map(c => { try { this.scope(c); } catch { return this.end(c); } }));
  }
}
