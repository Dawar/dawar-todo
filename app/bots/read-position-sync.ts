import { useEffect, useRef } from 'react';
import { portableHeaders } from '../../lib/portable-csrf';
import { readAt, validReadPosition, type BotReadPosition } from '../../lib/bot-read-position';
import type { Bot } from '../../lib/bots-types';
import { botsClient } from './client';
import { localReadAt, mergeReadPosition, subscribeReadPositions } from './local-read-state';
const scopeKey = (p: Pick<BotReadPosition, 'botId' | 'threadId'>) => JSON.stringify([p.botId, p.threadId]);
/** One owner-wide stream. Reads happen at open, focus, reconnect or committed
 * invalidation. Watermark writes are monotonic and safe after lost ACKs. */
export class ReadPositionSync {
  private active = false;
  private running = false;
  private again = false;
  private readPending = true;
  private failures = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private stream?: EventSource;
  private confirmed = new Map<string, string>();
  private unsubscribe?: () => void;
  constructor(private owner: string, private bots: () => Bot[], private allowed: () => boolean) {}
  private get url() { return `/api/bots/read?${new URLSearchParams({ owner: this.owner })}`; }
  private current(p: BotReadPosition) { return this.bots().some(bot => bot.id === p.botId && bot.threadId === p.threadId); }
  private request = async (body?: BotReadPosition) => {
    const response = await fetch(this.url, { method: body ? 'PATCH' : 'GET', credentials: 'same-origin', cache: 'no-store',
      headers: portableHeaders({ 'Content-Type': 'application/json' }), body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(8000) });
    const result = await response.json() as { owner: string; positions?: BotReadPosition[]; position?: BotReadPosition };
    if (!response.ok || result.owner !== this.owner) throw Error('Read sync unavailable.');
    return result;
  };
  private merge(p: BotReadPosition) {
    if (!this.active || !this.allowed() || !this.current(p)) return;
    const key = scopeKey(p), at = readAt(p.at);
    this.confirmed.set(key, [at, this.confirmed.get(key) ?? ''].sort().at(-1)!);
    mergeReadPosition(this.owner, p);
  }
  schedule = (read = false) => {
    if (!this.active || !this.allowed()) return;
    this.readPending ||= read;
    if (this.running) { this.again = true; return; }
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = undefined; void this.sync(); }, 0);
  };
  refresh = () => {
    if (!this.active || !this.allowed()) return;
    this.stream?.close(); this.stream = undefined;
    this.schedule(true);
    if (typeof EventSource !== 'undefined') {
      const stream = new EventSource(this.url.replace('/read?', '/read/events?')); this.stream = stream;
      let errors = 0;
      stream.addEventListener('changed', () => this.schedule(true));
      stream.onopen = () => { errors = 0; };
      stream.onerror = () => { if (!this.allowed() || ++errors >= 3) { stream.close(); if (this.stream === stream) this.stream = undefined; } };
    }
  };
  start() {
    this.active = true; this.unsubscribe = subscribeReadPositions(() => this.schedule());
    window.addEventListener('focus', this.refresh); window.addEventListener('online', this.refresh);
    document.addEventListener('visibilitychange', this.visible); this.refresh();
  }
  private visible = () => { if (document.visibilityState === 'visible') this.refresh(); };
  stop() {
    this.active = false; this.unsubscribe?.(); this.stream?.close();
    if (this.timer) clearTimeout(this.timer);
    window.removeEventListener('focus', this.refresh); window.removeEventListener('online', this.refresh);
    document.removeEventListener('visibilitychange', this.visible);
  }
  private async sync() {
    if (this.running || !this.active || !this.allowed()) return;
    this.running = true;
    try {
      if (this.readPending) {
        this.readPending = false;
        const result = await this.request();
        if (!Array.isArray(result.positions) || result.positions.length > 1024 || !result.positions.every(p => validReadPosition(p))) throw Error('Invalid read positions.');
        for (const p of result.positions) this.merge(p);
      }
      for (const bot of this.bots().slice(0, 1024)) {
        if (!this.active || !this.allowed()) return;
        const at = localReadAt(this.owner, bot);
        if (!bot.threadId || !at) continue;
        const position = { botId: bot.id, threadId: bot.threadId, at }, key = scopeKey(position);
        if (at <= (this.confirmed.get(key) ?? '')) continue;
        const result = await this.request(position);
        if (!validReadPosition(result.position) || result.position.botId !== position.botId || result.position.threadId !== position.threadId || readAt(result.position.at) < at) throw Error('Read position receipt unavailable.');
        this.merge(result.position);
      }
      this.failures = 0;
    } catch {
      this.readPending = true;
      if (++this.failures <= 3 && this.active && this.allowed()) this.timer = setTimeout(() => { this.timer = undefined; void this.sync(); }, 1000 * 2 ** this.failures);
    } finally {
      this.running = false;
      if (this.again) { this.again = false; this.schedule(); }
    }
  }
}
export function useSharedReadPositions(owner: string, bots: Bot[], enabled: boolean) {
  const current = useRef(bots), sync = useRef<ReadPositionSync | null>(null);
  const scopes = JSON.stringify(bots.map(bot => [bot.id, bot.threadId]));
  useEffect(() => { current.current = bots; sync.current?.schedule(); }, [bots]);
  useEffect(() => { sync.current?.schedule(true); }, [scopes]);
  useEffect(() => {
    if (!enabled || !owner) return;
    const value = new ReadPositionSync(owner, () => current.current, () => botsClient.owner === owner);
    sync.current = value; value.start();
    return () => { value.stop(); if (sync.current === value) sync.current = null; };
  }, [owner, enabled]);
}
