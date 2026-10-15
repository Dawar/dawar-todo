// Proactive bots settings with a synthetic transport, for screenshots. No
// bridge or hub is reached: initiative.read/configure/thread are answered in
// memory from a small fake ledger.
import React, { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { botsClient as client } from '../../app/bots/client';
import { ProactiveSettingsPage } from '../../app/bots/proactive-settings';
import { InitiativeSettings } from '../../app/bots/initiative-settings';
import '../../app/bots/bots.css';
import '../../app/bots/artifact-gallery.css';
import '../../app/bots/bot-details.css';

const params = new URLSearchParams(location.search), view = params.get('view') ?? 'global';
const bots = [['atlas', 'Atlas', '#216e4e'], ['connie', 'Connie', '#7a3fb0'], ['dwight', 'Dwight', '#b0563f'], ['sian', 'Sian', '#2f62b8']].map(([id, name, color]) => ({ id, name, slug: id,
  cwd: '/synthetic', threadId: `thread-${id}`, color, status: 'idle', archived: false, model: null, effort: null, mode: 'default', preview: '', updatedAt: '2026-10-15T00:00:00Z', lastReadAt: '2026-10-15T00:00:00Z', activeTurnId: null }));
client.start = () => {}; client.owner = 'synthetic-owner'; client.online = true;
client.snapshot = { bots, pending: [], cursor: 0, ready: true, models: [], schedules: [], runs: [], defaults: { model: 'synthetic', effort: 'medium' }, capabilities: { proactiveInitiative: 1 } };
const hour = 36e5, at = h => new Date(Date.now() - h * hour).toISOString();
let settings = { enabled: view !== 'bot-off', coverage: 'selected', bots: { atlas: { enabled: true, priorities: 'Keep client follow-ups moving.' }, connie: { enabled: true } }, scanMinutes: 25,
  baselineMinutes: 120, perBotDaily: 2, globalDaily: 5, priorities: 'Clients and revenue first; then the DawarTodo release.', looseThreads: true, triage: false, revision: 4 };
const threads = [
  { id: 't1', title: 'Call Acme about the renewal', status: 'candidate', due: true, ageHours: 47, responsibleBot: 'connie', responsibleName: 'Connie', snoozedUntil: null,
    mentions: [{ bot: 'Atlas', botId: 'atlas', at: at(47), quote: 'We should call Acme about their renewal before Friday.' }, { bot: 'Connie', botId: 'connie', at: at(5), quote: 'Acme renewal' }] },
  { id: 't2', title: 'Podcast pilot idea', status: 'published', due: false, ageHours: 30, responsibleBot: 'atlas', responsibleName: 'Atlas', snoozedUntil: null,
    mentions: [{ bot: 'Atlas', botId: 'atlas', at: at(30), quote: "I'm thinking about a short weekly podcast for customers." }] },
  { id: 't3', title: 'Hire a part-time designer', status: 'snoozed', due: false, ageHours: 96, responsibleBot: 'atlas', responsibleName: 'Atlas', snoozedUntil: new Date(Date.now() + 3 * 24 * hour).toISOString(),
    mentions: [{ bot: 'Dwight', botId: 'dwight', at: at(96), quote: 'Remind me to look at hiring a designer.' }] },
];
const included = id => !settings.enabled ? false : settings.coverage === 'selected' ? settings.bots[id]?.enabled === true : settings.bots[id]?.enabled !== false;
const rows = () => bots.map((b, i) => ({ botId: b.id, name: b.name, included: included(b.id), lastReviewAt: at(1 + i), nextReviewAt: new Date(Date.now() + (1 + i) * hour).toISOString(),
  failures: b.id === 'connie' ? 1 : 0, lastError: b.id === 'connie' ? 'The assigned machine was offline.' : null, lastErrorAt: b.id === 'connie' ? at(3) : null }));
const status = botId => ({ settings, looseThreads: threads, bots: rows(), metrics: { publishedToday: 2, reviewTokensToday: 48200, extractionTokensToday: 6400, openLooseThreads: 2 },
  bot: { ...rows().find(r => r.botId === botId) } });
client.rpc = async (method, botId, p) => {
  await new Promise(r => setTimeout(r, 30));
  if (method === 'initiative.configure') {
    const next = { ...settings, ...p.patch, bots: { ...settings.bots } };
    for (const [id, o] of Object.entries(p.patch.bots ?? {})) { const merged = { ...next.bots[id], ...o }; for (const k of Object.keys(o)) if (o[k] === null) delete merged[k]; next.bots[id] = merged; }
    settings = { ...next, revision: settings.revision + 1 };
  }
  if (method === 'initiative.thread') { const t = threads.find(x => x.id === p.itemId); t.status = { snooze: 'snoozed', dismiss: 'dismissed', resolve: 'resolved' }[p.action]; }
  return status(botId);
};
function BotPanel() {
  useEffect(() => { const d = document.querySelector('details'); if (d) d.open = true; }, []);
  return <aside className="bots-details" style={{ maxWidth: 440, margin: '0 auto', padding: 16 }}>
    <InitiativeSettings owner="synthetic-owner" botId="atlas" botName="Atlas" online onManage={() => {}} />
  </aside>;
}
createRoot(document.getElementById('root')).render(view === 'global'
  ? <div style={{ minHeight: '100vh', display: 'grid' }}><ProactiveSettingsPage owner="synthetic-owner" online bots={bots} onClose={() => {}} /></div>
  : <BotPanel />);
