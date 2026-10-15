"use client";
import { useId, type FormEvent, type ReactNode } from "react";
import type { Bot } from "../../lib/bots-types";
import { BotAvatar } from "./bot-avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { MODE_COPY, PROACTIVE_VIEW_HREF, botIncluded, botPatch, botSwitchCopy, modeOf, modePatch, type ModeSettings, type ProactiveMode, type SettingsPatch } from "./proactive-mode";

// Pure views for proactive-bot settings. The global page (all bots) and the
// per-bot panel share these; data loading and saving live in
// proactive-settings.tsx so these render the same in tests and the app.

export type ProactiveSettings = ModeSettings & { scanMinutes: number; baselineMinutes: number; perBotDaily: number; globalDaily: number; priorities: string;
  looseThreads: boolean; triage: boolean; reminderHours: number; reviewWhileBusy: boolean; revision: number };
export type LooseThread = { id: string; title: string; status: string; due: boolean; ageHours: number; responsibleBot: string; responsibleName: string;
  snoozedUntil: string | null; mentions: { bot: string; botId: string; at: string; quote: string }[] };
export type BotStatusRow = { botId: string; name: string; included: boolean; lastReviewAt: string | null; nextReviewAt: string | null; failures: number;
  lastError: string | null; lastErrorAt: string | null; skipped?: { since: string; reason: string } | null };
export type ProactiveStatus = { settings: ProactiveSettings; looseThreads: LooseThread[]; bots: BotStatusRow[];
  metrics: { publishedToday: number; reviewTokensToday: number; extractionTokensToday: number; openLooseThreads: number };
  bot: { botId: string; lastReviewAt: string | null; nextReviewAt: string | null; lastError: string | null; lastErrorAt: string | null } };
export type ThreadAction = "snooze" | "dismiss" | "resolve";
/** Which section is saving, which saved last, and the last error. */
export type SaveState = { saving: string | null; saved: string | null; error: string };

export const when = (value: string | null) => value ? new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "Not yet";
export const age = (hours: number) => hours < 1 ? "just now" : hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
const tokens = (n: number) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n);
const STATUS_COPY: Record<string, string> = { candidate: "Open", held: "Open", published: "Asked you", approved: "You said yes", snoozed: "Snoozed", resolved: "Done", dismissed: "Dismissed" };
const OPEN = new Set(["candidate", "held", "published", "approved"]);

function Section({ title, children, description, id }: { title: string; children: ReactNode; description?: string; id: string }) {
  return <section aria-labelledby={id} className="grid gap-3 border-t border-border pt-5 first:border-t-0 first:pt-0">
    <div><h2 id={id} className="text-base font-semibold tracking-[-0.01em] text-foreground">{title}</h2>
      {description && <p className="mt-1 text-sm leading-6 text-muted-foreground">{description}</p>}</div>
    {children}
  </section>;
}

/** Saving / Saved / error, announced politely next to the control that changed. */
export function SaveStatus({ state, section }: { state: SaveState; section: string }) {
  const text = state.saving === section ? "Saving…" : state.saved === section ? "Saved" : "";
  return <p role="status" aria-live="polite" className="text-[13px] text-muted-foreground empty:-mt-3">{text}</p>;
}

/** Off · Pilot · All bots, as one segmented radio group. */
export function ModeControl({ mode, onChange, disabled }: { mode: ProactiveMode; onChange: (mode: ProactiveMode) => void; disabled: boolean }) {
  const name = useId();
  return <fieldset className="grid gap-2" disabled={disabled}>
    <legend className="sr-only">Proactive mode</legend>
    <div className="grid grid-cols-3 rounded-lg border border-border bg-muted p-1">
      {(["off", "pilot", "all"] as const).map(value => <label key={value}
        className="relative flex min-h-10 cursor-pointer items-center justify-center rounded-md px-2 text-sm font-medium text-muted-foreground transition-colors has-checked:bg-background has-checked:text-foreground has-checked:shadow-sm has-focus-visible:ring-2 has-focus-visible:ring-ring">
        <input type="radio" name={name} value={value} checked={mode === value} onChange={() => onChange(value)} className="sr-only" />{MODE_COPY[value].label}
      </label>)}
    </div>
    <p className="text-sm text-muted-foreground">{MODE_COPY[mode].detail}</p>
  </fieldset>;
}

/** Loose threads with Snooze / Dismiss / Resolve; `showBot` names where each came from. */
export function LooseThreadList({ threads, onAction, disabled, showBot = true, empty }: { threads: LooseThread[]; onAction: (id: string, action: ThreadAction) => void; disabled: boolean; showBot?: boolean; empty: string }) {
  if (!threads.length) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return <ul className="grid gap-2">{threads.map(thread => {
    const first = thread.mentions[0], open = OPEN.has(thread.status);
    return <li key={thread.id} className="grid gap-2 rounded-lg border border-border bg-card p-3">
      <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <strong className="min-w-0 text-sm font-semibold text-foreground">{thread.title}</strong>
        <span className="text-[13px] text-muted-foreground">{STATUS_COPY[thread.status] ?? thread.status}{thread.due && open ? " · due" : ""}{thread.status === "snoozed" && thread.snoozedUntil ? ` until ${when(thread.snoozedUntil)}` : ""}</span>
      </div>
      {first && <blockquote className="border-l-2 border-border pl-3 text-sm leading-6 text-foreground">“{first.quote}”</blockquote>}
      <p className="text-[13px] text-muted-foreground">{showBot && first ? `Said to ${first.bot} · ` : ""}{age(thread.ageHours)}{thread.mentions.length > 1 ? ` · mentioned ${thread.mentions.length} times` : ""}</p>
      {(open || thread.status === "snoozed") && <div className="flex flex-wrap gap-2">
        {thread.status !== "snoozed" && <Button type="button" size="sm" variant="outline" disabled={disabled} aria-label={`Snooze “${thread.title}” for a week`} onClick={() => onAction(thread.id, "snooze")}>Snooze</Button>}
        <Button type="button" size="sm" variant="outline" disabled={disabled} aria-label={`Dismiss “${thread.title}”`} onClick={() => onAction(thread.id, "dismiss")}>Dismiss</Button>
        <Button type="button" size="sm" variant="outline" disabled={disabled} aria-label={`Resolve “${thread.title}”`} onClick={() => onAction(thread.id, "resolve")}>Resolve</Button>
      </div>}
    </li>;
  })}</ul>;
}

const numbers = (event: FormEvent<HTMLFormElement>) => { const form = new FormData(event.currentTarget); return (key: string) => Number(form.get(key)); };

/** The global "Proactive bots" settings: mode, pilot bots, what to bring up, pace, advanced, status and loose threads. */
export function ProactiveGlobalView({ status, bots, state, disabled, onConfigure, onThread }: { status: ProactiveStatus; bots: Pick<Bot, "id" | "name" | "status" | "avatar">[];
  state: SaveState; disabled: boolean; onConfigure: (patch: Record<string, unknown>, section: string) => void; onThread: (id: string, action: ThreadAction) => void }) {
  const s = status.settings, mode = modeOf(s), included = status.bots.filter(b => b.included);
  const busy = disabled || state.saving !== null;
  return <div className="grid gap-6">
    <Section id="proactive-mode" title="Mode" description="Proactive bots can bring things up with you on their own, as ordinary messages. They never act without your yes.">
      <ModeControl mode={mode} disabled={busy} onChange={next => onConfigure(modePatch(next), "mode")} />
      <SaveStatus state={state} section="mode" />
      {mode === "pilot" && <fieldset className="grid gap-1" disabled={busy}>
        <legend className="mb-1 text-sm font-medium text-foreground">Bots in the pilot</legend>
        <ul className="grid gap-1 sm:grid-cols-2">{bots.map(bot => <li key={bot.id}>
          <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-2 hover:bg-muted has-focus-visible:ring-2 has-focus-visible:ring-ring">
            <input type="checkbox" className="size-4 shrink-0 accent-primary" checked={botIncluded(s, bot.id)} onChange={event => onConfigure(botPatch("pilot", bot.id, event.target.checked)!, "pilot")} />
            <BotAvatar bot={bot} small decorative /><span className="min-w-0 truncate text-sm">{bot.name}</span>
          </label></li>)}</ul>
        <SaveStatus state={state} section="pilot" />
      </fieldset>}
    </Section>

    <Section id="proactive-topics" title="What to bring up">
      <label className="flex items-start gap-3 text-sm leading-6"><input type="checkbox" className="mt-1 size-4 shrink-0 accent-primary" disabled={busy} checked={s.looseThreads}
        onChange={event => onConfigure({ looseThreads: event.target.checked }, "threads")} />
        <span><span className="font-medium text-foreground">Things you mentioned that went nowhere</span><br /><span className="text-muted-foreground">Clients, ideas and plans you brought up that never led to anything. Bots raise them again at a sensible time.</span></span></label>
      <SaveStatus state={state} section="threads" />
      <form className="grid gap-2" key={`priorities:${s.revision}`} onSubmit={event => { event.preventDefault(); onConfigure({ priorities: String(new FormData(event.currentTarget).get("priorities") ?? "") }, "priorities"); }}>
        <label className="grid gap-1 text-sm font-medium text-foreground">Your priorities<span className="font-normal text-muted-foreground">What matters most right now. Every bot sees this.</span>
          <Textarea name="priorities" defaultValue={s.priorities} maxLength={8000} rows={3} disabled={busy} /></label>
        <div className="flex items-center gap-3"><Button type="submit" variant="outline" disabled={busy}>Save priorities</Button><SaveStatus state={state} section="priorities" /></div>
      </form>
    </Section>

    <Section id="proactive-pace" title="Pace" description="How often bots look for something to raise, and how many messages you get at most.">
      <form className="grid gap-3" key={`pace:${s.revision}`} onSubmit={event => { event.preventDefault(); const n = numbers(event);
        onConfigure({ baselineMinutes: Math.round(n("hours") * 60), perBotDaily: n("perBot"), globalDaily: n("total"), reminderHours: n("remind") }, "pace"); }}>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="grid gap-1 text-sm font-medium text-foreground">Look again every (hours)<Input name="hours" type="number" inputMode="decimal" min={0.5} max={168} step={0.5} defaultValue={s.baselineMinutes / 60} disabled={busy} /></label>
          <label className="grid gap-1 text-sm font-medium text-foreground">Messages per bot per day<Input name="perBot" type="number" inputMode="numeric" min={0} max={20} defaultValue={s.perBotDaily} disabled={busy} /></label>
          <label className="grid gap-1 text-sm font-medium text-foreground">Messages per day in total<Input name="total" type="number" inputMode="numeric" min={0} max={100} defaultValue={s.globalDaily} disabled={busy} /></label>
          <label className="grid gap-1 text-sm font-medium text-foreground">Remind me every (hours)<Input name="remind" type="number" inputMode="decimal" min={1} max={720} step={1} defaultValue={s.reminderHours} disabled={busy} /></label>
        </div>
        <p className="text-sm text-muted-foreground">Unanswered proposals come back as short reminders until you reply “yes, proceed”, “next week”, “leave it” or “done”.</p>
        <div className="flex items-center gap-3"><Button type="submit" variant="outline" disabled={busy}>Save pace</Button><SaveStatus state={state} section="pace" /></div>
      </form>
      <details className="rounded-lg border border-border px-3">
        <summary className="min-h-11 cursor-pointer py-3 text-sm font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Advanced</summary>
        <div className="grid gap-3 pb-3">
          <form className="grid gap-2" key={`scan:${s.revision}`} onSubmit={event => { event.preventDefault(); onConfigure({ scanMinutes: numbers(event)("scan") }, "scan"); }}>
            <label className="grid gap-1 text-sm font-medium text-foreground">Check which bots are due every (minutes)<span className="font-normal text-muted-foreground">A quick check with no AI cost. Lower means bots notice new activity sooner.</span>
              <Input name="scan" type="number" inputMode="numeric" min={5} max={1440} defaultValue={s.scanMinutes} disabled={busy} className="sm:max-w-40" /></label>
            <div className="flex items-center gap-3"><Button type="submit" variant="outline" disabled={busy}>Save</Button><SaveStatus state={state} section="scan" /></div>
          </form>
          <label className="flex items-start gap-3 text-sm leading-6"><input type="checkbox" className="mt-1 size-4 shrink-0 accent-primary" disabled={busy} checked={s.triage}
            onChange={event => onConfigure({ triage: event.target.checked }, "triage")} />
            <span><span className="font-medium text-foreground">Skip quiet bots</span><br /><span className="text-muted-foreground">Only look at bots with something new or due, which saves AI use.</span></span></label>
          <SaveStatus state={state} section="triage" />
          <label className="flex items-start gap-3 text-sm leading-6"><input type="checkbox" className="mt-1 size-4 shrink-0 accent-primary" disabled={busy} checked={s.reviewWhileBusy}
            onChange={event => onConfigure({ reviewWhileBusy: event.target.checked }, "busy")} />
            <span><span className="font-medium text-foreground">Review busy bots too</span><br /><span className="text-muted-foreground">Reviews are private and read-only, so they can run while a bot works. Messages still wait until it is free.</span></span></label>
          <SaveStatus state={state} section="busy" />
        </div>
      </details>
    </Section>

    <Section id="proactive-status" title="Status">
      <p className="text-sm text-muted-foreground">Today: {status.metrics.publishedToday} of {s.globalDaily} messages sent · {tokens(status.metrics.reviewTokensToday + status.metrics.extractionTokensToday)} AI tokens used</p>
      {mode === "off" ? <p className="text-sm text-muted-foreground">Proactive bots are off.</p> : !included.length ? <p className="text-sm text-muted-foreground">No bots take part yet.</p> :
        <ul className="grid divide-y divide-border rounded-lg border border-border">
          <li aria-hidden="true" className="hidden gap-3 px-3 py-2 text-[13px] font-medium text-muted-foreground sm:grid sm:grid-cols-[minmax(0,1.2fr)_1fr_1fr_minmax(0,1.4fr)]"><span>Bot</span><span>Last look</span><span>Next look</span><span>Last problem</span></li>
          {included.map(row => <li key={row.botId} className="grid gap-1 px-3 py-2 text-sm sm:grid-cols-[minmax(0,1.2fr)_1fr_1fr_minmax(0,1.4fr)] sm:gap-3">
            <span className="min-w-0 truncate font-medium text-foreground">{row.name}</span>
            <span className="text-muted-foreground"><span className="sm:hidden">Last look: </span>{when(row.lastReviewAt)}</span>
            <span className="text-muted-foreground"><span className="sm:hidden">Next look: </span>{when(row.nextReviewAt)}</span>
            <span className="min-w-0 break-words text-muted-foreground"><span className="sm:hidden">Last problem: </span>{row.skipped ? row.skipped.reason : row.lastError ? `${row.lastError} (${when(row.lastErrorAt)})` : "None"}</span>
          </li>)}
        </ul>}
    </Section>

    <Section id="proactive-threads" title="Loose threads" description="Things you mentioned to any bot that haven't led anywhere yet.">
      <LooseThreadList threads={status.looseThreads} onAction={onThread} disabled={busy} empty="Nothing waiting. Bots add things here as you mention them." />
      <SaveStatus state={state} section="thread" />
    </Section>
    {state.error && <p role="alert" className="text-sm text-destructive">{state.error}</p>}
  </div>;
}

/** Bot details → Settings: only this bot's own proactive controls. */
export function ProactiveBotView({ status, botId, botName, state, disabled, onConfigure, onThread, onManage }: { status: ProactiveStatus; botId: string; botName: string;
  state: SaveState; disabled: boolean; onConfigure: (patch: SettingsPatch | Record<string, unknown>, section: string) => void; onThread: (id: string, action: ThreadAction) => void; onManage: () => void }) {
  const s = status.settings, mode = modeOf(s), on = botIncluded(s, botId), busy = disabled || state.saving !== null;
  const manage = <a href={PROACTIVE_VIEW_HREF} className="text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    onClick={event => { event.preventDefault(); onManage(); }}>Manage proactive bots</a>;
  if (mode === "off") return <div className="grid gap-2">
    <p className="text-sm leading-6 text-muted-foreground">Proactive bots are off, so {botName} won&apos;t bring things up on its own. Turn them on for all bots or a pilot first.</p>
    {manage}
  </div>;
  const threads = status.looseThreads.filter(t => t.responsibleBot === botId && (OPEN.has(t.status) || t.status === "snoozed")).slice(0, 5);
  return <div className="grid gap-4">
    <div className="grid gap-1">
      <label className="flex items-center gap-3 text-sm font-medium text-foreground"><input type="checkbox" className="size-4 shrink-0 accent-primary" disabled={busy} checked={on}
        onChange={event => onConfigure(botPatch(mode, botId, event.target.checked)!, "bot")} />Proactive for {botName}</label>
      <p className="text-sm leading-6 text-muted-foreground">{botSwitchCopy(mode, botName, on)}</p>
      <SaveStatus state={state} section="bot" />
    </div>
    <form className="grid gap-2" key={`bot-priorities:${botId}:${s.revision}`} onSubmit={event => { event.preventDefault();
      onConfigure({ bots: { [botId]: { priorities: String(new FormData(event.currentTarget).get("priorities") ?? "") || null } } }, "bot-priorities"); }}>
      <label className="grid gap-1 text-sm font-medium text-foreground">Priorities for {botName}<span className="font-normal text-muted-foreground">Added to your general priorities for this bot only.</span>
        <Textarea name="priorities" defaultValue={s.bots[botId]?.priorities ?? ""} maxLength={4000} rows={2} disabled={busy} /></label>
      <div className="flex items-center gap-3"><Button type="submit" variant="outline" size="sm" disabled={busy}>Save</Button><SaveStatus state={state} section="bot-priorities" /></div>
    </form>
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
      <dt className="text-muted-foreground">Last look</dt><dd>{when(status.bot.lastReviewAt)}</dd>
      <dt className="text-muted-foreground">Next look</dt><dd>{on ? when(status.bot.nextReviewAt) : "Not taking part"}</dd>
      {status.bot.lastError && <><dt className="text-muted-foreground">Last problem</dt><dd className="break-words">{status.bot.lastError} ({when(status.bot.lastErrorAt)})</dd></>}
    </dl>
    <div className="grid gap-2">
      <h3 className="text-sm font-medium text-foreground">Loose threads {botName} follows up</h3>
      <LooseThreadList threads={threads} onAction={onThread} disabled={busy} showBot={false} empty="Nothing waiting." />
      <SaveStatus state={state} section="thread" />
    </div>
    {state.error && <p role="alert" className="text-sm text-destructive">{state.error}</p>}
    {manage}
  </div>;
}
