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

type ApiToken = {
  id: string;
  name: string;
  tokenPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
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

const compactOutlineActionClass = "inline-flex h-10 appearance-none items-center gap-2 rounded-xl border-0 bg-white px-3.5 text-sm font-semibold text-[#216e4e] ring-1 ring-black/[0.06] transition hover:bg-[#edf5f0] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#216e4e]";

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
  const [apiTokens, setApiTokens] = useState<ApiToken[]>([]);
  const [tokenName, setTokenName] = useState("Agent access");
  const [tokenExpiration, setTokenExpiration] = useState("90");
  const [tokensLoading, setTokensLoading] = useState(true);
  const [creatingToken, setCreatingToken] = useState(false);
  const [busyTokenId, setBusyTokenId] = useState<string | null>(null);
  const [createdToken, setCreatedToken] = useState<{ apiToken: ApiToken; token: string; skill: string } | null>(null);
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

    request<{ apiTokens: ApiToken[] }>("/api/api-tokens")
      .then(({ apiTokens: loadedTokens }) => {
        setApiTokens(loadedTokens);
        console.info("[todo-ui] API tokens loaded", { count: loadedTokens.length });
      })
      .catch((error: Error) => setShareNotice({ tone: "error", text: error.message }))
      .finally(() => setTokensLoading(false));
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

  async function createToken(event: FormEvent) {
    event.preventDefault();
    const name = tokenName.trim();
    if (!name) return;
    setCreatingToken(true);
    setShareNotice(null);
    try {
      const result = await request<{ apiToken: ApiToken; token: string; skill: string }>("/api/api-tokens", {
        method: "POST",
        body: JSON.stringify({
          name,
          expiresInDays: tokenExpiration === "never" ? null : Number(tokenExpiration),
        }),
      });
      setApiTokens((current) => [result.apiToken, ...current]);
      setCreatedToken(result);
      setTokenName("Agent access");
      setShareNotice({ tone: "success", text: "API token generated. Copy it now." });
      console.info("[todo-ui] API token generated", { tokenId: result.apiToken.id, expiresAt: result.apiToken.expiresAt });
    } catch (error) {
      setShareNotice({ tone: "error", text: error instanceof Error ? error.message : "The API token could not be generated." });
    } finally {
      setCreatingToken(false);
    }
  }

  async function copyApiToken() {
    if (!createdToken) return;
    try {
      await copyTextToClipboard(createdToken.token);
      setShareNotice({ tone: "success", text: "API token copied." });
      console.info("[todo-ui] API token copied", { tokenId: createdToken.apiToken.id });
    } catch (error) {
      setShareNotice({ tone: "error", text: error instanceof Error ? error.message : "The API token could not be copied." });
    }
  }

  async function copyCreatedTokenSkill() {
    if (!createdToken) return;
    try {
      await copyTextToClipboard(createdToken.skill);
      setShareNotice({ tone: "success", text: "SKILL.md copied." });
      console.info("[todo-ui] one-time API token skill copied", { tokenId: createdToken.apiToken.id, skillLength: createdToken.skill.length });
    } catch (error) {
      setShareNotice({ tone: "error", text: error instanceof Error ? error.message : "The API skill could not be copied." });
    }
  }

  async function copyOpenApiUrl() {
    try {
      await copyTextToClipboard(`${window.location.origin}/openapi.json`);
      setShareNotice({ tone: "success", text: "OpenAPI URL copied." });
      console.info("[todo-ui] OpenAPI URL copied");
    } catch (error) {
      setShareNotice({ tone: "error", text: error instanceof Error ? error.message : "The OpenAPI URL could not be copied." });
    }
  }

  async function revokeToken(apiToken: ApiToken) {
    if (!window.confirm(`Revoke ${apiToken.name}? Any agent using it will lose access immediately.`)) return;
    setBusyTokenId(apiToken.id);
    setShareNotice(null);
    try {
      await request<{ id: string; revoked: true }>(`/api/api-tokens/${apiToken.id}`, { method: "DELETE" });
      setApiTokens((current) => current.filter((item) => item.id !== apiToken.id));
      if (createdToken?.apiToken.id === apiToken.id) setCreatedToken(null);
      setShareNotice({ tone: "success", text: `${apiToken.name} revoked.` });
      console.info("[todo-ui] API token revoked", { tokenId: apiToken.id });
    } catch (error) {
      setShareNotice({ tone: "error", text: error instanceof Error ? error.message : "The API token could not be revoked." });
    } finally {
      setBusyTokenId(null);
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

        <section aria-labelledby="api-access-title" className="mt-6 rounded-2xl border border-black/[0.07] bg-white p-5 shadow-[0_10px_35px_rgba(30,45,36,0.06)] sm:p-7">
          <div className="flex items-start gap-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[#eaf3ed] text-[#216e4e]"><ActionIcon name="link" className="h-5 w-5" /></span>
            <div className="min-w-0">
              <h2 id="api-access-title" className="text-lg font-semibold tracking-[-0.02em] text-[#202522]">API access</h2>
              <p className="mt-1 text-sm leading-6 text-[#69716c]">Create a personal Bearer token for agents and automations to manage your tasks, projects, attachments, and settings.</p>
            </div>
          </div>

          <div className="mt-4 rounded-xl bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-900">
            Tokens have full access to this todo database. Treat them like passwords. The token and its credentialed SKILL.md are available only when created, and every token can be revoked at any time.
          </div>

          <form onSubmit={createToken} className="mt-5 grid min-w-0 gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
            <label className="min-w-0">
              <span className="sr-only">Token name</span>
              <input
                value={tokenName}
                onChange={(event) => setTokenName(event.target.value)}
                maxLength={80}
                placeholder="Token name"
                className="h-11 w-full min-w-0 rounded-xl border border-black/[0.1] px-3 text-[16px] outline-none focus:border-[#216e4e]/50 focus:ring-3 focus:ring-[#216e4e]/10"
              />
            </label>
            <label>
              <span className="sr-only">Token expiration</span>
              <select value={tokenExpiration} onChange={(event) => setTokenExpiration(event.target.value)} className="h-11 w-full rounded-xl border border-black/[0.1] bg-white px-3 text-sm outline-none focus:border-[#216e4e]/50 focus:ring-3 focus:ring-[#216e4e]/10 sm:w-auto">
                <option value="30">30 days</option>
                <option value="90">90 days</option>
                <option value="365">1 year</option>
                <option value="never">Never expires</option>
              </select>
            </label>
            <button type="submit" disabled={creatingToken || !tokenName.trim()} className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-[#216e4e] px-4 text-sm font-semibold text-white hover:bg-[#195d41] disabled:opacity-50">
              <ActionIcon name="add" />
              {creatingToken ? "Generating…" : "Generate token"}
            </button>
          </form>

          {createdToken && (
            <div className="mt-4 rounded-xl border border-[#216e4e]/20 bg-[#f1f7f3] p-3.5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-[#24553f]">Copy this token now</p>
                  <p className="mt-0.5 text-xs leading-5 text-[#607169]">The raw token and credentialed SKILL.md are available only until you dismiss this panel.</p>
                </div>
                <button type="button" onClick={() => setCreatedToken(null)} aria-label="Dismiss generated token" title="Dismiss" className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-[#607169] hover:bg-black/[0.05]"><ActionIcon name="close" /></button>
              </div>
              <textarea readOnly value={createdToken.token} onFocus={(event) => event.currentTarget.select()} aria-label="Generated API token" rows={2} className="mt-3 w-full resize-none break-all rounded-lg border border-[#216e4e]/15 bg-white p-3 font-mono text-xs leading-5 text-[#303632] outline-none focus:border-[#216e4e]/50" />
              <div className="mt-2 flex flex-wrap gap-2">
                <button type="button" onClick={() => void copyApiToken()} className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-white px-3 text-xs font-semibold text-[#216e4e] ring-1 ring-black/[0.06] hover:bg-[#edf5f0]"><ActionIcon name="copy" />Copy token</button>
                <button type="button" onClick={() => void copyCreatedTokenSkill()} className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-white px-3 text-xs font-semibold text-[#216e4e] ring-1 ring-black/[0.06] hover:bg-[#edf5f0]"><ActionIcon name="copy" />Copy Skill</button>
              </div>
            </div>
          )}

          <div className="mt-5 rounded-xl border border-black/[0.07] bg-[#fafbf9] p-3.5">
            <p className="text-sm font-semibold text-[#303632]">Agent documentation</p>
            <p className="mt-1 text-xs leading-5 text-[#7c847f]">Use the public OpenAPI 3.1 specification to discover request bodies, responses, and Bearer authentication.</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <a href="/openapi.json" target="_blank" rel="noreferrer" className={compactOutlineActionClass}><ActionIcon name="link" />Open specification</a>
              <button type="button" onClick={() => void copyOpenApiUrl()} className={compactOutlineActionClass}><ActionIcon name="copy" />Copy OpenAPI URL</button>
            </div>
          </div>

          <div className="mt-5 border-t border-black/[0.07] pt-5">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-[#69716c]">Active tokens</h3>
            {tokensLoading ? (
              <div role="status" aria-label="Loading API tokens" className="mt-3 space-y-3">
                {[0, 1].map((item) => <div key={item} className="h-24 animate-pulse rounded-xl bg-[#f1f3f0]" />)}
              </div>
            ) : apiTokens.length ? (
              <ul className="mt-3 space-y-3">
                {apiTokens.map((apiToken) => (
                  <li key={apiToken.id} className="flex min-w-0 items-start justify-between gap-3 rounded-xl border border-black/[0.07] bg-[#fafbf9] p-3.5">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-[#303632]">{apiToken.name}</p>
                      <p className="mt-1 font-mono text-xs text-[#69716c]">{apiToken.tokenPrefix}</p>
                      <p className="mt-1 text-xs leading-5 text-[#8a918d]">
                        {apiToken.lastUsedAt ? `Last used ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(apiToken.lastUsedAt))}` : "Never used"}
                        {apiToken.expiresAt ? ` · Expires ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(apiToken.expiresAt))}` : " · Never expires"}
                      </p>
                    </div>
                    <button type="button" onClick={() => void revokeToken(apiToken)} disabled={busyTokenId === apiToken.id} className="inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-lg bg-white px-3 text-xs font-semibold text-red-700 ring-1 ring-black/[0.06] hover:bg-red-50 disabled:opacity-50"><ActionIcon name="delete" />Revoke</button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 rounded-xl border border-dashed border-black/[0.1] px-4 py-5 text-center text-sm text-[#8a918d]">No active API tokens.</p>
            )}
          </div>
        </section>

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
