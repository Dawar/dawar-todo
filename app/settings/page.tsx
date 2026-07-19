"use client";

import { FormEvent, useEffect, useState } from "react";
import { ActionIcon } from "../action-icon";
import { copyTextToClipboard } from "../copy-to-clipboard";
import { SiteHeader } from "../site-header";

type Settings = {
  snoozeTimeZone: string;
  snoozeWakeHour: number;
};

type CalendarFeed = {
  id: string;
  name: string;
  url: string;
  createdAt: string;
  updatedAt: string;
};

const timeZones = [
  ["America/Toronto", "Eastern · Toronto"],
  ["America/New_York", "Eastern · New York"],
  ["America/Chicago", "Central"],
  ["America/Denver", "Mountain"],
  ["America/Los_Angeles", "Pacific"],
  ["Europe/London", "London"],
  ["UTC", "UTC"],
];

function hourLabel(hour: number) {
  if (hour === 0) return "12:00 AM";
  if (hour < 12) return `${hour}:00 AM`;
  if (hour === 12) return "12:00 PM";
  return `${hour - 12}:00 PM`;
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: options?.body ? { "Content-Type": "application/json", ...(options.headers ?? {}) } : options?.headers,
  });
  const payload = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error || "Something went wrong.");
  return payload;
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<Settings>({ snoozeTimeZone: "America/Toronto", snoozeWakeHour: 8 });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [saved, setSaved] = useState(false);
  const [calendarFeeds, setCalendarFeeds] = useState<CalendarFeed[]>([]);
  const [calendarName, setCalendarName] = useState("Dawar Todo");
  const [feedsLoading, setFeedsLoading] = useState(true);
  const [creatingFeed, setCreatingFeed] = useState(false);
  const [busyFeedId, setBusyFeedId] = useState<string | null>(null);
  const [shareNotice, setShareNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    request<{ settings: Settings }>("/api/settings")
      .then(({ settings: loaded }) => {
        setSettings(loaded);
        console.info("[todo-ui] settings loaded", loaded);
      })
      .catch((error: Error) => setMessage(error.message))
      .finally(() => setLoading(false));

    request<{ feeds: CalendarFeed[] }>("/api/calendar-feeds")
      .then(({ feeds }) => {
        setCalendarFeeds(feeds);
        console.info("[todo-ui] calendar feeds loaded", { count: feeds.length });
      })
      .catch((error: Error) => setShareNotice({ tone: "error", text: error.message }))
      .finally(() => setFeedsLoading(false));
  }, []);

  useEffect(() => {
    if (!shareNotice) return;
    const timer = window.setTimeout(() => setShareNotice(null), 5_000);
    return () => window.clearTimeout(timer);
  }, [shareNotice]);

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setSaved(false);
    setMessage("");
    try {
      const { settings: persisted } = await request<{ settings: Settings }>("/api/settings", {
        method: "PATCH",
        body: JSON.stringify(settings),
      });
      setSettings(persisted);
      setSaved(true);
      console.info("[todo-ui] settings saved", persisted);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Settings could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  async function createFeed(event: FormEvent) {
    event.preventDefault();
    const name = calendarName.trim();
    if (!name) return;
    setCreatingFeed(true);
    setShareNotice(null);
    try {
      const { feed } = await request<{ feed: CalendarFeed }>("/api/calendar-feeds", {
        method: "POST",
        body: JSON.stringify({ name }),
      });
      setCalendarFeeds((current) => [feed, ...current]);
      setCalendarName("Dawar Todo");
      setShareNotice({ tone: "success", text: "Public calendar link generated." });
      console.info("[todo-ui] calendar feed generated", { id: feed.id, nameLength: feed.name.length });
    } catch (error) {
      setShareNotice({ tone: "error", text: error instanceof Error ? error.message : "The calendar link could not be generated." });
    } finally {
      setCreatingFeed(false);
    }
  }

  async function copyFeed(feed: CalendarFeed) {
    try {
      await copyTextToClipboard(feed.url);
      setShareNotice({ tone: "success", text: `${feed.name} link copied.` });
      console.info("[todo-ui] calendar feed link copied", { id: feed.id });
    } catch (error) {
      setShareNotice({ tone: "error", text: error instanceof Error ? error.message : "The calendar link could not be copied." });
    }
  }

  async function regenerateFeed(feed: CalendarFeed) {
    if (!window.confirm(`Replace the public link for ${feed.name}? The current link will stop working immediately.`)) return;
    setBusyFeedId(feed.id);
    setShareNotice(null);
    try {
      const result = await request<{ feed: CalendarFeed }>(`/api/calendar-feeds/${feed.id}`, { method: "PATCH" });
      setCalendarFeeds((current) => current.map((item) => item.id === feed.id ? result.feed : item));
      setShareNotice({ tone: "success", text: `${feed.name} link regenerated. Copy the new link.` });
      console.info("[todo-ui] calendar feed regenerated", { id: feed.id });
    } catch (error) {
      setShareNotice({ tone: "error", text: error instanceof Error ? error.message : "The calendar link could not be regenerated." });
    } finally {
      setBusyFeedId(null);
    }
  }

  async function revokeFeed(feed: CalendarFeed) {
    if (!window.confirm(`Revoke the public link for ${feed.name}? Calendar apps using it will stop receiving updates.`)) return;
    setBusyFeedId(feed.id);
    setShareNotice(null);
    try {
      await request<{ id: string; revoked: true }>(`/api/calendar-feeds/${feed.id}`, { method: "DELETE" });
      setCalendarFeeds((current) => current.filter((item) => item.id !== feed.id));
      setShareNotice({ tone: "success", text: `${feed.name} link revoked.` });
      console.info("[todo-ui] calendar feed revoked", { id: feed.id });
    } catch (error) {
      setShareNotice({ tone: "error", text: error instanceof Error ? error.message : "The calendar link could not be revoked." });
    } finally {
      setBusyFeedId(null);
    }
  }

  return (
    <main className="min-h-screen bg-[#f6f7f5] text-[#1d211f]">
      <SiteHeader current="settings" />
      <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6 sm:py-12">
        <div className="mb-7">
          <p className="text-sm font-medium text-[#216e4e]">Profile</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-[-0.04em] text-[#151816]">Daily review</h1>
          <p className="mt-2 text-sm leading-6 text-[#69716c]">Choose when snoozed tasks return to your open list.</p>
        </div>

        <form onSubmit={save} className="rounded-2xl border border-black/[0.07] bg-white p-5 shadow-[0_10px_35px_rgba(30,45,36,0.06)] sm:p-7">
          <fieldset disabled={loading || saving} className="space-y-5 disabled:opacity-60">
            <label className="block">
              <span className="mb-2 block text-sm font-semibold text-[#303632]">Time zone</span>
              <select
                value={settings.snoozeTimeZone}
                onChange={(event) => { setSettings((current) => ({ ...current, snoozeTimeZone: event.target.value })); setSaved(false); }}
                className="h-12 w-full rounded-xl border border-black/[0.1] bg-white px-3 text-sm outline-none transition focus:border-[#216e4e]/60 focus:ring-3 focus:ring-[#216e4e]/10"
              >
                {timeZones.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>

            <label className="block">
              <span className="mb-2 block text-sm font-semibold text-[#303632]">Wake-up time</span>
              <select
                value={settings.snoozeWakeHour}
                onChange={(event) => { setSettings((current) => ({ ...current, snoozeWakeHour: Number(event.target.value) })); setSaved(false); }}
                className="h-12 w-full rounded-xl border border-black/[0.1] bg-white px-3 text-sm outline-none transition focus:border-[#216e4e]/60 focus:ring-3 focus:ring-[#216e4e]/10"
              >
                {Array.from({ length: 24 }, (_, hour) => <option key={hour} value={hour}>{hourLabel(hour)}</option>)}
              </select>
            </label>
          </fieldset>

          <div className="mt-6 rounded-xl bg-[#f1f6f3] px-4 py-3 text-sm leading-6 text-[#4f6257]">
            Snoozing hides a task until {hourLabel(settings.snoozeWakeHour)} on the next calendar day in {timeZones.find(([zone]) => zone === settings.snoozeTimeZone)?.[1] ?? settings.snoozeTimeZone}.
          </div>

          {message && <p role="alert" className="mt-4 text-sm text-red-700">{message}</p>}

          <div className="mt-6 flex items-center gap-3">
            <button type="submit" disabled={loading || saving} className="rounded-xl bg-[#216e4e] px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-[#195d41] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#216e4e] disabled:opacity-50">
              {saving ? "Saving…" : "Save settings"}
            </button>
            {saved && <span role="status" className="text-sm font-medium text-[#216e4e]">Saved</span>}
          </div>
        </form>

        <section aria-labelledby="calendar-sharing-title" className="mt-6 rounded-2xl border border-black/[0.07] bg-white p-5 shadow-[0_10px_35px_rgba(30,45,36,0.06)] sm:p-7">
          <div className="flex items-start gap-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[#eaf3ed] text-[#216e4e]"><ActionIcon name="calendar" className="h-5 w-5" /></span>
            <div className="min-w-0">
              <h2 id="calendar-sharing-title" className="text-lg font-semibold tracking-[-0.02em] text-[#202522]">Calendar sharing</h2>
              <p className="mt-1 text-sm leading-6 text-[#69716c]">Generate a secure, public iCal subscription containing every task with a due date. Calendar apps receive updates automatically.</p>
            </div>
          </div>

          <div className="mt-4 rounded-xl bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-900">
            Anyone with a link can read the titles, notes, project, context, status, and due dates in that feed. Regenerate or revoke a link whenever access should end.
          </div>

          <form onSubmit={createFeed} className="mt-5 flex min-w-0 flex-col gap-2 sm:flex-row">
            <label className="min-w-0 flex-1">
              <span className="sr-only">Calendar name</span>
              <input
                value={calendarName}
                onChange={(event) => setCalendarName(event.target.value)}
                maxLength={80}
                placeholder="Calendar name"
                className="h-11 w-full min-w-0 rounded-xl border border-black/[0.1] px-3 text-[16px] outline-none focus:border-[#216e4e]/50 focus:ring-3 focus:ring-[#216e4e]/10"
              />
            </label>
            <button type="submit" disabled={creatingFeed || !calendarName.trim()} className="inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-xl bg-[#216e4e] px-4 text-sm font-semibold text-white hover:bg-[#195d41] disabled:opacity-50">
              <ActionIcon name="link" />
              {creatingFeed ? "Generating…" : "Generate link"}
            </button>
          </form>

          <div className="mt-5 border-t border-black/[0.07] pt-5">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-[#69716c]">Active links</h3>
            {feedsLoading ? (
              <div role="status" aria-label="Loading calendar links" className="mt-3 space-y-3">
                {[0, 1].map((item) => <div key={item} className="h-28 animate-pulse rounded-xl bg-[#f1f3f0]" />)}
              </div>
            ) : calendarFeeds.length ? (
              <ul className="mt-3 space-y-3">
                {calendarFeeds.map((feed) => (
                  <li key={feed.id} className="min-w-0 rounded-xl border border-black/[0.07] bg-[#fafbf9] p-3.5">
                    <div className="flex min-w-0 items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-[#303632]">{feed.name}</p>
                        <p className="mt-0.5 text-xs text-[#8a918d]">Created {new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(feed.createdAt))}</p>
                      </div>
                      <button type="button" onClick={() => void copyFeed(feed)} className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-white text-[#216e4e] shadow-sm ring-1 ring-black/[0.06] hover:bg-[#edf5f0]" aria-label={`Copy ${feed.name} calendar link`} title="Copy link"><ActionIcon name="copy" /></button>
                    </div>
                    <input readOnly value={feed.url} onFocus={(event) => event.currentTarget.select()} aria-label={`${feed.name} public calendar URL`} className="mt-3 h-10 w-full min-w-0 rounded-lg border border-black/[0.08] bg-white px-3 font-mono text-xs text-[#69716c] outline-none focus:border-[#216e4e]/50" />
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button type="button" onClick={() => void copyFeed(feed)} className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-white px-3 text-xs font-semibold text-[#216e4e] ring-1 ring-black/[0.06] hover:bg-[#edf5f0]"><ActionIcon name="copy" />Copy link</button>
                      <button type="button" onClick={() => void regenerateFeed(feed)} disabled={busyFeedId === feed.id} className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-white px-3 text-xs font-semibold text-[#59615c] ring-1 ring-black/[0.06] hover:bg-[#f1f3f0] disabled:opacity-50"><ActionIcon name="retry" />Regenerate</button>
                      <button type="button" onClick={() => void revokeFeed(feed)} disabled={busyFeedId === feed.id} className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-white px-3 text-xs font-semibold text-red-700 ring-1 ring-black/[0.06] hover:bg-red-50 disabled:opacity-50"><ActionIcon name="delete" />Revoke</button>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 rounded-xl border border-dashed border-black/[0.1] px-4 py-5 text-center text-sm text-[#8a918d]">No public calendar links yet.</p>
            )}
          </div>
        </section>
      </div>

      {shareNotice && (
        <div className="pointer-events-none fixed inset-x-0 bottom-[max(1rem,env(safe-area-inset-bottom))] z-[60] mx-auto w-[calc(100%-2rem)] max-w-md">
          <div role={shareNotice.tone === "error" ? "alert" : "status"} className={`pointer-events-auto flex min-h-14 items-center gap-3 rounded-2xl px-4 py-3 text-sm text-white shadow-[0_16px_50px_rgba(0,0,0,0.24)] ${shareNotice.tone === "error" ? "bg-red-700" : "bg-[#202522]"}`}>
            <span className="min-w-0 flex-1 font-medium">{shareNotice.text}</span>
            <button type="button" onClick={() => setShareNotice(null)} aria-label="Dismiss notification" className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-white/65 hover:bg-white/10 hover:text-white"><ActionIcon name="close" /></button>
          </div>
        </div>
      )}
    </main>
  );
}
