"use client";
import { useId, type FormEvent, type ReactNode } from "react";
import type { Bot } from "../../lib/bots-types";
import { BotAvatar } from "./bot-avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { MODE_COPY, PROACTIVE_VIEW_HREF, botIncluded, botPatch, botSwitchCopy, modeOf, modePatch, type ModeSettings, type ProactiveMode, type SettingsPatch } from "./proactive-mode";

// Pure views for the bots' inner monologue. The global page (all bots) and
// each bot's Mind panel share these; loading and saving live in
// proactive-settings.tsx so these render the same in tests and the app.

export type ProactiveSettings = ModeSettings & { priorities: string; messagesEnabled: boolean; activeMinutes: number; idleMinutes: number; nightMinutes: number;
  quietStart: string; quietEnd: string; timeZone: string; perBotDaily: number; globalDaily: number; speakWithBotModel: boolean; reviewWhileBusy: boolean; revision: number };
export type MindLoop = { id: string; title: string; status: "open" | "raised" | "done" | "dropped"; note: string; raisedAt: string | null; updatedAt: string | null };
export type MindEntry = { id: string; at: string; kind: "thought" | "note"; thought: string; decision: "quiet" | "speak"; message: string | null;
  messageState: "drafting" | "queued" | "delivered" | "dropped" | "withheld" | null; reason: string | null; tokens: number };
export type BotStatusRow = { botId: string; name: string; included: boolean; lastThinkAt: string | null; nextThinkAt: string | null; lastThought: string | null;
  failures: number; lastError: string | null; lastErrorAt: string | null; skipped?: { since: string; reason: string } | null };
export type ProactiveStatus = { settings: ProactiveSettings; bots: BotStatusRow[]; quietNow: boolean;
  metrics: { thoughtsToday: number; messagesToday: number; tokensToday: number; waiting: number };
  bot: { botId: string; lastThinkAt: string | null; nextThinkAt: string | null; lastError: string | null; lastErrorAt: string | null;
    skipped?: { since: string; reason: string } | null; loops: MindLoop[]; journal: MindEntry[] } };
/** Which section is saving, which saved last, and the last error. */
export type SaveState = { saving: string | null; saved: string | null; error: string };

export const when = (value: string | null) => value ? new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "Not yet";
const tokens = (n: number) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n);
const LOOP_COPY: Record<MindLoop["status"], string> = { open: "On its mind", raised: "Asked you", done: "Done", dropped: "Let go" };
const MESSAGE_COPY: Record<string, string> = { drafting: "Writing it", queued: "Waiting to send", delivered: "Sent", withheld: "Not sent", dropped: "Not sent" };
const DROP_COPY: Record<string, string> = { "owner-spoke": "you wrote first", expired: "too late to send", "turned-off": "proactive bots were turned off",
  paused: "messages are paused", "bot-missing": "the bot is gone" };

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

/** A bot's open loops: what it is tracking for you, and where each stands. */
export function LoopList({ loops, empty }: { loops: MindLoop[]; empty: string }) {
  if (!loops.length) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return <ul className="grid gap-1.5">{loops.map(loop => <li key={loop.id} className="grid gap-0.5 rounded-md border border-border bg-card px-3 py-2">
    <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3">
      <span className={`min-w-0 text-sm font-medium ${loop.status === "done" || loop.status === "dropped" ? "text-muted-foreground line-through" : "text-foreground"}`}>{loop.title}</span>
      <span className="text-[13px] text-muted-foreground">{LOOP_COPY[loop.status]}{loop.status === "raised" && loop.raisedAt ? ` · ${when(loop.raisedAt)}` : ""}</span>
    </div>
    {loop.note && <p className="text-[13px] leading-5 text-muted-foreground">{loop.note}</p>}
  </li>)}</ul>;
}

/** The journal: one entry per thought, newest first, with anything the bot said. */
export function Journal({ entries, empty }: { entries: MindEntry[]; empty: string }) {
  if (!entries.length) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return <ol className="grid gap-3" aria-label="Thoughts, newest first">{entries.map(entry => <li key={entry.id} className="grid gap-1.5 border-l-2 border-border pl-3">
    <p className="text-[13px] text-muted-foreground">{when(entry.at)}{entry.kind === "note" ? " · noted in conversation" : ""}</p>
    <p className="text-sm italic leading-6 text-foreground">{entry.thought}</p>
    {entry.message && entry.messageState && <div className="grid gap-1 rounded-md bg-muted px-3 py-2">
      <p className="text-[13px] font-medium text-muted-foreground">{(entry.messageState === "dropped" || entry.messageState === "withheld") && entry.reason ? `Not sent: ${DROP_COPY[entry.reason] ?? entry.reason}` : MESSAGE_COPY[entry.messageState] ?? entry.messageState}</p>
      <p className="whitespace-pre-wrap text-sm leading-6 text-foreground">{entry.message}</p>
    </div>}
  </li>)}</ol>;
}

const numbers = (event: FormEvent<HTMLFormElement>) => { const form = new FormData(event.currentTarget); return (key: string) => Number(form.get(key)); };
const field = "grid gap-1 text-sm font-medium text-foreground";

/** The global "Proactive bots" settings: mode, priorities, rhythm, quiet hours, messages, advanced and status. */
export function ProactiveGlobalView({ status, bots, state, disabled, onConfigure }: { status: ProactiveStatus; bots: Pick<Bot, "id" | "name" | "status" | "avatar">[];
  state: SaveState; disabled: boolean; onConfigure: (patch: Record<string, unknown>, section: string) => void }) {
  const s = status.settings, mode = modeOf(s), included = status.bots.filter(b => b.included);
  const busy = disabled || state.saving !== null;
  return <div className="grid gap-6">
    <Section id="proactive-mode" title="Mode" description="Each bot has an inner monologue: every so often it thinks about its own conversation with you, keeps a journal and its own open loops, and messages you when it has something worth your attention. Its journal is in its Mind panel.">
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

    <Section id="proactive-priorities" title="Your priorities">
      <form className="grid gap-2" key={`priorities:${s.revision}`} onSubmit={event => { event.preventDefault(); onConfigure({ priorities: String(new FormData(event.currentTarget).get("priorities") ?? "") }, "priorities"); }}>
        <label className={field}>What matters most right now<span className="font-normal text-muted-foreground">Every bot keeps this in mind when it thinks.</span>
          <Textarea name="priorities" defaultValue={s.priorities} maxLength={8000} rows={3} disabled={busy} /></label>
        <div className="flex items-center gap-3"><Button type="submit" variant="outline" disabled={busy}>Save priorities</Button><SaveStatus state={state} section="priorities" /></div>
      </form>
    </Section>

    <Section id="proactive-rhythm" title="Rhythm" description="How often each bot stops to think. Each wait varies a little, so bots don't all think at once. A bot can also ask to think again sooner or later.">
      <form className="grid gap-3" key={`rhythm:${s.revision}`} onSubmit={event => { event.preventDefault(); const n = numbers(event);
        onConfigure({ activeMinutes: n("active"), idleMinutes: n("idle"), nightMinutes: n("night") }, "rhythm"); }}>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className={field}>After a conversation (minutes)<Input name="active" type="number" inputMode="numeric" min={10} max={1440} defaultValue={s.activeMinutes} disabled={busy} /></label>
          <label className={field}>Otherwise (minutes)<Input name="idle" type="number" inputMode="numeric" min={15} max={1440} defaultValue={s.idleMinutes} disabled={busy} /></label>
          <label className={field}>Overnight (minutes)<Input name="night" type="number" inputMode="numeric" min={30} max={1440} defaultValue={s.nightMinutes} disabled={busy} /></label>
        </div>
        <div className="flex items-center gap-3"><Button type="submit" variant="outline" disabled={busy}>Save rhythm</Button><SaveStatus state={state} section="rhythm" /></div>
      </form>
    </Section>

    <Section id="proactive-messages" title="Messages" description={`Every message from a bot sends you a push. Bots space their messages out and stay silent during quiet hours (${s.timeZone.replace(/_/g, " ")} time); anything they decide overnight waits for the morning.`}>
      <label className="flex items-start gap-3 text-sm leading-6"><input type="checkbox" className="mt-1 size-4 shrink-0 accent-primary" disabled={busy} checked={s.messagesEnabled}
        onChange={event => onConfigure({ messagesEnabled: event.target.checked }, "send")} />
        <span><span className="font-medium text-foreground">Send messages</span><br /><span className="text-muted-foreground">{s.messagesEnabled ? "Bots message you when they decide to." : "Paused: bots keep thinking, and what they would have said stays in their journals."}</span></span></label>
      <SaveStatus state={state} section="send" />
      <form className="grid gap-3" key={`messages:${s.revision}`} onSubmit={event => { event.preventDefault(); const form = new FormData(event.currentTarget); const n = numbers(event);
        onConfigure({ quietStart: String(form.get("quietStart")), quietEnd: String(form.get("quietEnd")), perBotDaily: n("perBot"), globalDaily: n("total") }, "messages"); }}>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className={field}>Quiet from<Input name="quietStart" type="time" defaultValue={s.quietStart} disabled={busy} /></label>
          <label className={field}>Quiet until<Input name="quietEnd" type="time" defaultValue={s.quietEnd} disabled={busy} /></label>
          <label className={field}>Per bot per day<Input name="perBot" type="number" inputMode="numeric" min={0} max={50} defaultValue={s.perBotDaily} disabled={busy} /></label>
          <label className={field}>In total per day<Input name="total" type="number" inputMode="numeric" min={0} max={200} defaultValue={s.globalDaily} disabled={busy} /></label>
        </div>
        <div className="flex items-center gap-3"><Button type="submit" variant="outline" disabled={busy}>Save messages</Button><SaveStatus state={state} section="messages" /></div>
      </form>
      <details className="rounded-lg border border-border px-3">
        <summary className="min-h-11 cursor-pointer py-3 text-sm font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Advanced</summary>
        <div className="grid gap-3 pb-3">
          <label className="flex items-start gap-3 text-sm leading-6"><input type="checkbox" className="mt-1 size-4 shrink-0 accent-primary" disabled={busy} checked={s.speakWithBotModel}
            onChange={event => onConfigure({ speakWithBotModel: event.target.checked }, "speak")} />
            <span><span className="font-medium text-foreground">Write messages with each bot&apos;s own model</span><br /><span className="text-muted-foreground">Thinking uses a light model. When a bot decides to speak, its own model writes the message in its voice.</span></span></label>
          <SaveStatus state={state} section="speak" />
          <label className="flex items-start gap-3 text-sm leading-6"><input type="checkbox" className="mt-1 size-4 shrink-0 accent-primary" disabled={busy} checked={s.reviewWhileBusy}
            onChange={event => onConfigure({ reviewWhileBusy: event.target.checked }, "busy")} />
            <span><span className="font-medium text-foreground">Think while working</span><br /><span className="text-muted-foreground">Thinking is private and read-only, so it can happen while a bot works. Messages still wait until it is free.</span></span></label>
          <SaveStatus state={state} section="busy" />
        </div>
      </details>
    </Section>

    <Section id="proactive-status" title="Status">
      <p className="text-sm text-muted-foreground">Today: {status.metrics.thoughtsToday} thoughts · {s.messagesEnabled ? `${status.metrics.messagesToday} of ${s.globalDaily} messages sent` : "messages paused"}{status.metrics.waiting ? ` · ${status.metrics.waiting} waiting` : ""} · {tokens(status.metrics.tokensToday)} AI tokens{status.quietNow ? " · quiet hours now" : ""}</p>
      {mode === "off" ? <p className="text-sm text-muted-foreground">Proactive bots are off.</p> : !included.length ? <p className="text-sm text-muted-foreground">No bots take part yet.</p> :
        <ul className="grid divide-y divide-border rounded-lg border border-border">
          {included.map(row => <li key={row.botId} className="grid gap-1 px-3 py-2.5 text-sm">
            <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
              <span className="min-w-0 truncate font-medium text-foreground">{row.name}</span>
              <span className="text-[13px] text-muted-foreground">Thought {when(row.lastThinkAt)} · next {when(row.nextThinkAt)}</span>
            </div>
            {row.skipped || row.lastError ? <p className="break-words text-[13px] text-destructive">{row.skipped ? row.skipped.reason : `${row.lastError} (${when(row.lastErrorAt)})`}</p>
              : row.lastThought && <p className="text-[13px] italic leading-5 text-muted-foreground">{row.lastThought}</p>}
          </li>)}
        </ul>}
    </Section>
    {state.error && <p role="alert" className="text-sm text-destructive">{state.error}</p>}
  </div>;
}

/** A bot's Mind panel: its switch, what it is tracking, and its journal of thoughts. */
export function ProactiveBotView({ status, botId, botName, state, disabled, onConfigure, onThinkNow, onManage }: { status: ProactiveStatus; botId: string; botName: string;
  state: SaveState; disabled: boolean; onConfigure: (patch: SettingsPatch | Record<string, unknown>, section: string) => void; onThinkNow: () => void; onManage: () => void }) {
  const s = status.settings, mode = modeOf(s), on = botIncluded(s, botId), busy = disabled || state.saving !== null;
  const manage = <a href={PROACTIVE_VIEW_HREF} className="text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    onClick={event => { event.preventDefault(); onManage(); }}>Manage proactive bots</a>;
  if (mode === "off") return <div className="grid gap-2">
    <p className="text-sm leading-6 text-muted-foreground">Proactive bots are off, so {botName} doesn&apos;t think on its own. Turn them on for all bots or a pilot first.</p>
    {manage}
  </div>;
  const open = status.bot.loops.filter(l => l.status === "open" || l.status === "raised"), closed = status.bot.loops.filter(l => l.status === "done" || l.status === "dropped");
  return <div className="grid gap-4">
    <div className="grid gap-1">
      <label className="flex items-center gap-3 text-sm font-medium text-foreground"><input type="checkbox" className="size-4 shrink-0 accent-primary" disabled={busy} checked={on}
        onChange={event => onConfigure(botPatch(mode, botId, event.target.checked)!, "bot")} />Inner monologue for {botName}</label>
      <p className="text-sm leading-6 text-muted-foreground">{botSwitchCopy(mode, botName, on)}</p>
      <SaveStatus state={state} section="bot" />
    </div>
    {on && <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onThinkNow}>Think now</Button>
      <p className="text-[13px] text-muted-foreground">Last thought {when(status.bot.lastThinkAt)} · next {when(status.bot.nextThinkAt)}</p>
      <SaveStatus state={state} section="think" />
    </div>}
    {(status.bot.skipped || status.bot.lastError) && <p className="break-words text-sm text-destructive">{status.bot.skipped ? status.bot.skipped.reason : `${status.bot.lastError} (${when(status.bot.lastErrorAt)})`}</p>}
    <div className="grid gap-2">
      <h3 className="text-sm font-medium text-foreground">On {botName}&apos;s mind</h3>
      <LoopList loops={[...open, ...closed]} empty="Nothing it is tracking yet." />
    </div>
    <div className="grid gap-2">
      <h3 className="text-sm font-medium text-foreground">Journal</h3>
      <Journal entries={status.bot.journal} empty={on ? `${botName} hasn't had a thought yet. Its first one comes soon, or press Think now.` : "No thoughts yet."} />
    </div>
    <form className="grid gap-2" key={`bot-priorities:${botId}:${s.revision}`} onSubmit={event => { event.preventDefault();
      onConfigure({ bots: { [botId]: { priorities: String(new FormData(event.currentTarget).get("priorities") ?? "") || null } } }, "bot-priorities"); }}>
      <label className={field}>Priorities for {botName}<span className="font-normal text-muted-foreground">Added to your general priorities for this bot only.</span>
        <Textarea name="priorities" defaultValue={s.bots[botId]?.priorities ?? ""} maxLength={4000} rows={2} disabled={busy} /></label>
      <div className="flex items-center gap-3"><Button type="submit" variant="outline" size="sm" disabled={busy}>Save</Button><SaveStatus state={state} section="bot-priorities" /></div>
    </form>
    {state.error && <p role="alert" className="text-sm text-destructive">{state.error}</p>}
    {manage}
  </div>;
}
