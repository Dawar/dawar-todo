import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentDesktopTransport, HubDesktopTransport } from '../portable/desktop-transport.mjs';
import { initializeProfile, profileContext } from '../bot-bridge/profiles.mjs';
import { runtime as tsRuntime } from './helpers/load-ts.mjs';

const clientId = '11111111-1111-4111-8111-111111111111', botId = '22222222-2222-4222-8222-222222222222',
  parentId = '33333333-3333-4333-8333-333333333333', token = 'a'.repeat(64);
const settle = () => new Promise(resolve => setTimeout(resolve, 20));
function quiet(t) {
  const warn = console.warn, reasons = [];
  console.warn = (_, json) => reasons.push(JSON.parse(json));
  t.after(() => { console.warn = warn; });
  return reasons;
}

function agentFixture({ control = () => ({}), slowPing = null, hangOpen = () => false } = {}) {
  const frames = [], written = [];
  const socket = { readyState: 1, bufferedAmount: 0, send: value => frames.push(JSON.parse(value)) };
  const runtime = {
    store: { bot: () => ({ id: botId }) },
    maintenance: { track: async fn => fn(), admit: async fn => fn() },
    desktops: {
      assertBot() {},
      async message(m, send) {
        if (m.event === 'open' && hangOpen(m)) await new Promise(() => {});
        if (m.event === 'open') send({ type: 'desktop', event: 'ready', clientId: m.clientId, password: 'p' });
        if (m.event === 'ping' && slowPing) await slowPing;
        if (m.event === 'data') written.push(m.data);
      },
      async end() {},
    },
  };
  const transport = new AgentDesktopTransport({ runtime, journal: { currentControl: () => control() }, currentSocket: () => socket });
  // Mirrors the agent's socket handler: frames are taken one per promise turn
  // and any synchronous throw closes the shared node connection.
  let chain = Promise.resolve(), nodeClosed = false;
  const deliver = m => {
    chain = chain.then(() => { void transport.message(socket, { clientId, botId, epoch: 1, ...m })?.catch(() => {}); }).catch(() => { nodeClosed = true; });
    return chain;
  };
  return { transport, frames, written, deliver, nodeClosed: () => nodeClosed };
}

test('a burst of already-received input frames keeps the viewer open and in order', async t => {
  const reasons = quiet(t);
  const f = agentFixture();
  f.deliver({ event: 'open', parentId, token });
  await settle();
  // One network read after an event-loop pause: ws emits every frame at once.
  // Before the fix ~100 instant frames overran the 64-frame bound and ended
  // the viewer with "Desktop transport ended." (input-frame-limit).
  for (let i = 0; i < 500; i++) f.deliver({ event: 'data', data: Buffer.from([5, 0, i >> 8, i & 255, 0, 0]).toString('base64') });
  await settle();
  assert.deepEqual(reasons, []);
  assert.equal(f.frames.some(frame => frame.event === 'closed'), false);
  assert.equal(f.written.length, 500);
  assert.deepEqual(f.written.map(d => Buffer.from(d, 'base64').readUInt16BE(2)), [...Array(500).keys()]);
  assert.equal(f.transport.channels.get(clientId).pending, 0);
});

test('input still waits behind unfinished control work and stays bounded', async t => {
  const reasons = quiet(t);
  let release;
  const f = agentFixture({ slowPing: new Promise(resolve => { release = resolve; }) });
  f.deliver({ event: 'open', parentId, token });
  await settle();
  f.deliver({ event: 'ping' });
  for (let i = 0; i < 10; i++) f.deliver({ event: 'data', data: 'BQAAAAAA' });
  await settle();
  assert.equal(f.written.length, 0, 'data never overtakes an unfinished ping');
  release();
  await settle();
  assert.equal(f.written.length, 10);
  // A genuinely stuck operation still ends the viewer once 64 frames wait.
  let hold;
  const g = agentFixture({ slowPing: new Promise(resolve => { hold = resolve; }) });
  g.deliver({ event: 'open', parentId, token });
  await settle();
  g.deliver({ event: 'ping' });
  for (let i = 0; i < 70; i++) g.deliver({ event: 'data', data: 'BQAAAAAA' });
  await settle();
  assert.equal(reasons.at(-1).reason, 'input-frame-limit');
  hold();
});

test('a viewer scope failure ends that viewer without closing the shared node connection', async t => {
  const reasons = quiet(t);
  let fresh = true;
  const f = agentFixture({ control: () => fresh ? {} : null });
  f.deliver({ event: 'open', parentId, token });
  await settle();
  fresh = false;
  f.deliver({ event: 'data', data: 'BQAAAAAA' });
  await settle();
  assert.equal(f.nodeClosed(), false);
  assert.equal(reasons.at(-1).reason, 'control-snapshot-unavailable');
  assert.equal(f.frames.at(-1).event, 'closed');
  // The same at open: refused for this viewer only.
  const g = agentFixture({ control: () => null });
  g.deliver({ event: 'open', parentId, token });
  await settle();
  assert.equal(g.nodeClosed(), false);
  assert.equal(g.frames.at(-1).event, 'closed');
});

function hubFixture() {
  const hello = { platform: 'linux', capabilities: { desktop: true } };
  const nodeFrames = [];
  const node = { readyState: 1, portableHello: hello, send: value => nodeFrames.push(JSON.parse(value)) };
  const store = { placement: () => ({ node_id: 'node', epoch: 1 }), node: () => ({ hello: JSON.stringify(hello) }) };
  let parentAlive = true, viewerBacklog = false, closed = 0;
  const hub = new HubDesktopTransport({ store, connections: new Map([['node', node]]), parent: () => parentAlive });
  hub.open({ owner: 'o', clientId, parentId, botId, token, expiresAt: Date.now() + 60_000,
    send: () => { if (viewerBacklog) throw Error('Desktop output unavailable.'); }, close: () => { closed++; } });
  return { hub, node, nodeFrames, closed: () => closed, backlog: () => { viewerBacklog = true; }, dropParent: () => { parentAlive = false; } };
}

test('a backed-up viewer socket ends only that viewer on the hub', t => {
  const reasons = quiet(t);
  const f = hubFixture();
  f.backlog();
  // Before the fix this threw, and the gateway closed the node socket
  // ("Node frame rejected"), disconnecting every bot.
  assert.doesNotThrow(() => f.hub.receive('node', f.node, { type: 'desktop-response', event: 'data', clientId, botId, epoch: 1, data: 'AAAA' }));
  assert.equal(f.closed(), 1);
  assert.equal(f.nodeFrames.at(-1).event, 'close');
  assert.deepEqual(reasons.map(r => [r.side, r.reason]), [['hub', 'viewer-output-unavailable']]);
  // A frame from a foreign scope remains a node protocol fault.
  const g = hubFixture();
  assert.throws(() => g.hub.receive('node', g.node, { type: 'desktop-response', event: 'data', clientId, botId, epoch: 2, data: 'AAAA' }));
});

test('hub closures record their category', t => {
  const reasons = quiet(t);
  const f = hubFixture();
  f.dropParent();
  f.hub.receive('node', f.node, { type: 'desktop-response', event: 'data', clientId, botId, epoch: 1, data: 'AAAA' });
  assert.equal(reasons.at(-1).reason, 'parent-disconnected');
});

function reconnectFixture() {
  const { load } = tsRuntime({ performance });
  const { DesktopReconnect, desktopTransientClose } = load('app/bots/desktop-reconnect.ts');
  let now = 0, ready = true, reopened = 0, gaveUp = 0;
  const timers = [];
  const r = new DesktopReconnect(() => ready, () => { reopened++; }, () => { gaveUp++; }, () => now,
    (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, () => {});
  const fire = () => { const timer = timers.shift(); now += timer.ms; timer.fn(); return timer.ms; };
  return { r, fire, timers, desktopTransientClose, set: v => { ({ now = now, ready = ready } = v); }, counts: () => ({ reopened, gaveUp }), at: () => now };
}

test('transient viewer loss reopens a bounded number of times, then waits for a person', () => {
  const f = reconnectFixture();
  const delays = [];
  for (let i = 0; i < 3; i++) { assert.equal(f.r.failed(), true); delays.push(f.fire()); }
  assert.deepEqual(delays, [1000, 2000, 4000]);
  assert.equal(f.counts().reopened, 3);
  assert.equal(f.r.failed(), false, 'a flapping stream stops reopening');
  f.r.reset();
  assert.equal(f.r.failed(), true, 'manual reconnect restores attempts');
});

test('a viewer that stayed up earns fresh attempts; an offline parent is waited for, not raced', () => {
  const f = reconnectFixture();
  for (let i = 0; i < 3; i++) { f.r.failed(); f.fire(); }
  f.r.connected();
  f.set({ now: f.at() + 61_000 });
  assert.equal(f.r.failed(), true);
  f.set({ ready: false });
  f.fire();
  assert.equal(f.counts().reopened, 3, 'no reopen while DawarTodo is offline');
  for (let i = 0; i < 30 && f.timers.length; i++) f.fire();
  assert.equal(f.counts().gaveUp, 1);
  assert.equal(f.counts().reopened, 3);
});

test('only lost-stream closes are reopened automatically', () => {
  const { desktopTransientClose } = reconnectFixture();
  for (const error of ['Desktop transport ended.', 'Desktop disconnected.', 'Desktop connection expired.', 'Service disconnected.'])
    assert.equal(desktopTransientClose(error), true, error);
  for (const error of ['Desktop stopped.', 'Another browser has exclusive desktop control.', 'Desktop ticket expired or belongs to another browser.',
    'Restore this bot before using its desktop.', undefined])
    assert.equal(desktopTransientClose(error), false, String(error));
});

test('oversized memory awaiting recovery does not block an ordinary send', async t => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-isolation-memory-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bot = { id: 'bot', cwd: join(root, 'bot'), name: 'Member' };
  await initializeProfile(bot);
  await writeFile(join(bot.cwd, 'MEMORY.md'), `# Memory\n${'fact\n'.repeat(30_000)}`);
  const states = [];
  const context = await profileContext(bot, null, { threadPolicy: true, onMemoryState: state => states.push(state) });
  assert.match(context.botProfile.value, /reviewed summary is not ready/);
  assert.match(context.botProfile.value, new RegExp(join(bot.cwd, 'MEMORY.md').replaceAll('/', '\\/')));
  assert.doesNotMatch(context.botProfile.value, /fact\nfact\nfact/, 'the oversized body is not inlined');
  assert.equal(states.at(-1).state, 'blocked', 'memory status still reports the pending recovery');
});

test('a viewer closed while its open is still pending does not let a later open close the shared node connection', async t => {
  quiet(t);
  const viewer = i => `11111111-1111-4111-8111-${String(i).padStart(12, '0')}`;
  const f = agentFixture({ hangOpen: m => m.clientId === viewer(0) });
  // Viewer 0 is closed while its desktop connect is still running: the hub forgets it, the node retires it.
  f.deliver({ clientId: viewer(0), event: 'open', parentId, token });
  f.deliver({ clientId: viewer(0), event: 'close' });
  await settle();
  // The hub admits up to 8 live viewers.
  for (let i = 1; i <= 8; i++) f.deliver({ clientId: viewer(i), event: 'open', parentId, token });
  await settle();
  assert.equal(f.nodeClosed(), false);
  const refused = f.frames.filter(frame => frame.event === 'closed' && frame.clientId === viewer(8));
  assert.equal(refused.length, 1, 'the viewer over the cap is refused on its own');
});
