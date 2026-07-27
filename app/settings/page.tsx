"use client";

import { FormEvent, useEffect, useState } from "react";
import { ActionIcon } from "../action-icon";
import {
  appleMobileBadgeRequiresNotificationPermission,
  currentOpenTaskCount,
  supportsNativeAppBadge,
  updateNativeAppBadge,
} from "../app-badge";
import { copyTextToClipboard } from "../copy-to-clipboard";
import { getOrCreateDeviceId, headersWithDeviceId } from "../device-id";
import { SiteHeader } from "../site-header";
import {
  DEFAULT_QUICK_SNOOZE_PRESETS,
  QUICK_SNOOZE_OPTIONS,
  sortQuickSnoozePresets,
  type QuickSnoozePreset,
} from "../../lib/snooze-presets";
import {
  DEFAULT_REALTIME_VOICE,
  REALTIME_VOICE_OPTIONS,
  type RealtimeVoice,
} from "../../lib/ai-preferences";

type Settings = {
  snoozeTimeZone: string;
  snoozeWakeHour: number;
  snoozeQuickPresets: QuickSnoozePreset[];
  realtimeVoice: RealtimeVoice;
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

type TalkPhoneProfile = {
  configured: boolean;
  webhookUrl: string | null;
  providerConfiguredAt: string | null;
  pinUpdatedAt: string | null;
  lastAuthenticatedAt: string | null;
  updatedAt: string | null;
  providerReady: boolean;
  phoneNumber: string;
};

type BadgePermission = NotificationPermission | "not-required" | "unavailable";
type BadgeTodo = { status: "open" | "completed"; snoozedUntil: string | null };
type PushState = "checking" | "unsupported" | "unconfigured" | "blocked" | "disabled" | "enabled";

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

function pushCapabilityAvailable() {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

function pushApplicationServerKey(value: string) {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const decoded = window.atob((value + padding).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const headers = options?.body ? { "Content-Type": "application/json", ...(options.headers ?? {}) } : options?.headers;
  const response = await fetch(path, {
    ...options,
    headers: headersWithDeviceId(headers),
  });
  const payload = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error || "Something went wrong.");
  return payload;
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<Settings>({
    snoozeTimeZone: "America/Toronto",
    snoozeWakeHour: 8,
    snoozeQuickPresets: DEFAULT_QUICK_SNOOZE_PRESETS,
    realtimeVoice: DEFAULT_REALTIME_VOICE,
  });
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
  const [badgeSupported, setBadgeSupported] = useState<boolean | null>(null);
  const [badgeRequiresPermission, setBadgeRequiresPermission] = useState(false);
  const [badgePermission, setBadgePermission] = useState<BadgePermission>("unavailable");
  const [updatingBadge, setUpdatingBadge] = useState(false);
  const [pushState, setPushState] = useState<PushState>("checking");
  const [pushPublicKey, setPushPublicKey] = useState("");
  const [updatingPush, setUpdatingPush] = useState(false);
  const [talkPhoneProfile, setTalkPhoneProfile] = useState<TalkPhoneProfile | null>(null);
  const [talkPhonePin, setTalkPhonePin] = useState("");
  const [talkPhoneLoading, setTalkPhoneLoading] = useState(true);
  const [talkPhoneSaving, setTalkPhoneSaving] = useState(false);
  const [talkPhoneMessage, setTalkPhoneMessage] = useState("");

  useEffect(() => {
    request<{ settings: Settings }>("/api/settings")
      .then(({ settings: loaded }) => {
        setSettings({
          ...loaded,
          snoozeQuickPresets: loaded.snoozeQuickPresets ?? DEFAULT_QUICK_SNOOZE_PRESETS,
          realtimeVoice: loaded.realtimeVoice ?? DEFAULT_REALTIME_VOICE,
        });
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

    request<{ profile: TalkPhoneProfile }>("/api/talk/phone/profile", { cache: "no-store" })
      .then(({ profile }) => {
        setTalkPhoneProfile(profile);
        console.info("[todo-talk-phone-ui] phone profile loaded", {
          configured: profile.configured,
          providerReady: profile.providerReady,
          providerConfigured: Boolean(profile.providerConfiguredAt),
        });
      })
      .catch((error: Error) => setTalkPhoneMessage(error.message))
      .finally(() => setTalkPhoneLoading(false));

    const badgeCheck = window.setTimeout(() => {
      const supportsBadge = supportsNativeAppBadge();
      const requiresPermission = supportsBadge && appleMobileBadgeRequiresNotificationPermission();
      setBadgeSupported(supportsBadge);
      setBadgeRequiresPermission(requiresPermission);
      setBadgePermission(requiresPermission && "Notification" in window ? Notification.permission : supportsBadge ? "not-required" : "unavailable");
      console.info("[todo-pwa] app badge capability checked", {
        supported: supportsBadge,
        requiresNotificationPermission: requiresPermission,
        notificationPermission: requiresPermission && "Notification" in window ? Notification.permission : "not-required",
      });
    }, 0);
    const pushCheck = window.setTimeout(() => {
      void (async () => {
        if (!pushCapabilityAvailable()) {
          setPushState("unsupported");
          console.info("[todo-push] browser push capability unavailable");
          return;
        }
        try {
          const config = await request<{ configured: boolean; publicKey: string | null; subscribed: boolean }>("/api/push", {
            cache: "no-store",
          });
          if (!config.configured || !config.publicKey) {
            setPushState("unconfigured");
            return;
          }
          setPushPublicKey(config.publicKey);
          if (Notification.permission === "denied") {
            setPushState("blocked");
            return;
          }
          const registration = await navigator.serviceWorker.ready;
          const subscription = await registration.pushManager.getSubscription();
          if (subscription && !config.subscribed) {
            await request("/api/push", {
              method: "POST",
              body: JSON.stringify({ ...subscription.toJSON(), deviceId: getOrCreateDeviceId() }),
            });
            console.info("[todo-push] existing browser subscription restored on server");
          }
          setPushState(subscription ? "enabled" : "disabled");
          console.info("[todo-push] settings state loaded", {
            browserSubscribed: Boolean(subscription),
            serverSubscribed: config.subscribed,
            permission: Notification.permission,
          });
        } catch (error) {
          setPushState("disabled");
          console.error("[todo-push] settings state failed", { error });
        }
      })();
    }, 0);
    return () => {
      window.clearTimeout(badgeCheck);
      window.clearTimeout(pushCheck);
    };
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

  function updateQuickSnoozePreset(index: number, value: QuickSnoozePreset) {
    setSettings((current) => {
      const next = [...current.snoozeQuickPresets];
      next[index] = value;
      const snoozeQuickPresets = sortQuickSnoozePresets(next);
      console.info("[todo-ui] Quick Snooze preference changed", {
        changedSlot: index,
        selected: value,
        sortedPresets: snoozeQuickPresets,
      });
      return { ...current, snoozeQuickPresets };
    });
    setSaved(false);
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

  async function enableAppBadge() {
    if (!badgeSupported || updatingBadge) return;
    setUpdatingBadge(true);
    setShareNotice(null);
    try {
      if (badgeRequiresPermission) {
        if (!("Notification" in window)) throw new Error("Notification permission is unavailable on this device.");
        const permission = Notification.permission === "default"
          ? await Notification.requestPermission()
          : Notification.permission;
        setBadgePermission(permission);
        if (permission !== "granted") {
          throw new Error(permission === "denied"
            ? "Badge permission is blocked. Allow notifications for Dawar Todo in device settings."
            : "Badge permission was not enabled.");
        }
      }

      const { todos } = await request<{ todos: BadgeTodo[] }>("/api/todos");
      const count = currentOpenTaskCount(todos);
      const result = await updateNativeAppBadge(count, "settings");
      if (!result.updated) throw new Error("The app badge could not be updated on this device.");
      setShareNotice({ tone: "success", text: `App badge enabled with ${count} open ${count === 1 ? "task" : "tasks"}.` });
      console.info("[todo-pwa] app badge enabled from settings", { count, badgeRequiresPermission });
    } catch (error) {
      setShareNotice({ tone: "error", text: error instanceof Error ? error.message : "The app badge could not be enabled." });
      console.error("[todo-pwa] app badge enable failed", { badgeRequiresPermission, error });
    } finally {
      setUpdatingBadge(false);
    }
  }

  async function enablePushNotifications() {
    if (updatingPush || !pushCapabilityAvailable()) return;
    setUpdatingPush(true);
    setShareNotice(null);
    try {
      const permission = Notification.permission === "default"
        ? await Notification.requestPermission()
        : Notification.permission;
      setBadgePermission(permission);
      if (permission !== "granted") {
        setPushState(permission === "denied" ? "blocked" : "disabled");
        throw new Error(permission === "denied"
          ? "Notifications are blocked. Allow Dawar Todo in device notification settings."
          : "Notification permission was not enabled.");
      }
      let publicKey = pushPublicKey;
      if (!publicKey) {
        const config = await request<{ configured: boolean; publicKey: string | null }>("/api/push", { cache: "no-store" });
        if (!config.configured || !config.publicKey) throw new Error("Push notifications are not configured yet.");
        publicKey = config.publicKey;
        setPushPublicKey(publicKey);
      }
      const registration = await navigator.serviceWorker.ready;
      const existing = await registration.pushManager.getSubscription();
      const subscription = existing ?? await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: pushApplicationServerKey(publicKey),
      });
      await request("/api/push", {
        method: "POST",
        body: JSON.stringify({ ...subscription.toJSON(), deviceId: getOrCreateDeviceId() }),
      });
      setPushState("enabled");
      setShareNotice({ tone: "success", text: "Push notifications enabled on this device." });
      console.info("[todo-push] notifications enabled", {
        reusedBrowserSubscription: Boolean(existing),
        permission,
      });
      const { todos } = await request<{ todos: BadgeTodo[] }>("/api/todos");
      await updateNativeAppBadge(currentOpenTaskCount(todos), "push-enabled");
    } catch (error) {
      setShareNotice({ tone: "error", text: error instanceof Error ? error.message : "Push notifications could not be enabled." });
      console.error("[todo-push] notification enable failed", { error });
    } finally {
      setUpdatingPush(false);
    }
  }

  async function disablePushNotifications() {
    if (updatingPush || !pushCapabilityAvailable()) return;
    setUpdatingPush(true);
    setShareNotice(null);
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      await request("/api/push", {
        method: "DELETE",
        body: JSON.stringify({ endpoint: subscription?.endpoint ?? null, deviceId: getOrCreateDeviceId() }),
      });
      if (subscription) await subscription.unsubscribe();
      setPushState("disabled");
      setShareNotice({ tone: "success", text: "Push notifications disabled on this device." });
      console.info("[todo-push] notifications disabled", { hadBrowserSubscription: Boolean(subscription) });
    } catch (error) {
      setShareNotice({ tone: "error", text: error instanceof Error ? error.message : "Push notifications could not be disabled." });
      console.error("[todo-push] notification disable failed", { error });
    } finally {
      setUpdatingPush(false);
    }
  }

  async function saveTalkPhonePin(event: FormEvent) {
    event.preventDefault();
    if (!/^\d{6,8}$/.test(talkPhonePin)) {
      setTalkPhoneMessage("Choose a 6 to 8 digit PIN.");
      return;
    }
    setTalkPhoneSaving(true);
    setTalkPhoneMessage("");
    try {
      const { profile } = await request<{ profile: TalkPhoneProfile }>("/api/talk/phone/profile", {
        method: "PUT",
        body: JSON.stringify({ pin: talkPhonePin }),
      });
      setTalkPhoneProfile(profile);
      setTalkPhonePin("");
      setTalkPhoneMessage(`Phone access enabled. Call ${profile.phoneNumber}.`);
      console.info("[todo-talk-phone-ui] phone PIN saved and provider connected", {
        providerConfigured: Boolean(profile.providerConfiguredAt),
      });
    } catch (error) {
      setTalkPhoneMessage(error instanceof Error ? error.message : "Phone access could not be configured.");
      console.error("[todo-talk-phone-ui] phone setup failed", { error });
    } finally {
      setTalkPhoneSaving(false);
    }
  }

  async function reconnectTalkPhone() {
    setTalkPhoneSaving(true);
    setTalkPhoneMessage("");
    try {
      const { profile } = await request<{ profile: TalkPhoneProfile }>("/api/talk/phone/profile", {
        method: "POST",
      });
      setTalkPhoneProfile(profile);
      setTalkPhoneMessage("Twilio number connected.");
      console.info("[todo-talk-phone-ui] provider webhook refreshed");
    } catch (error) {
      setTalkPhoneMessage(error instanceof Error ? error.message : "The Twilio number could not be connected.");
      console.error("[todo-talk-phone-ui] provider refresh failed", { error });
    } finally {
      setTalkPhoneSaving(false);
    }
  }

  async function disableTalkPhone() {
    if (!window.confirm("Disable PIN access to the Talk phone number?")) return;
    setTalkPhoneSaving(true);
    setTalkPhoneMessage("");
    try {
      const { profile } = await request<{ profile: TalkPhoneProfile }>("/api/talk/phone/profile", {
        method: "DELETE",
      });
      setTalkPhoneProfile(profile);
      setTalkPhonePin("");
      setTalkPhoneMessage("Phone access disabled.");
      console.info("[todo-talk-phone-ui] phone access disabled");
    } catch (error) {
      setTalkPhoneMessage(error instanceof Error ? error.message : "Phone access could not be disabled.");
      console.error("[todo-talk-phone-ui] phone disable failed", { error });
    } finally {
      setTalkPhoneSaving(false);
    }
  }

  return (
    <main className="min-h-screen bg-[#f6f7f5] text-[#1d211f]">
      <SiteHeader current="settings" />
      <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6 sm:py-12">
        <div className="mb-7">
          <p className="text-sm font-medium text-[#216e4e]">Profile</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-[-0.04em] text-[#151816]">Preferences</h1>
          <p className="mt-2 text-sm leading-6 text-[#69716c]">Control task timing, AI behavior, and device features.</p>
        </div>

        <form onSubmit={save} className="rounded-2xl border border-black/[0.07] bg-white p-5 shadow-[0_10px_35px_rgba(30,45,36,0.06)] sm:p-7">
          <fieldset disabled={loading || saving} className="space-y-5 disabled:opacity-60">
            <div>
              <h2 className="text-lg font-semibold tracking-[-0.02em] text-[#202522]">Daily review</h2>
              <p className="mt-1 text-sm leading-6 text-[#69716c]">Choose the timezone for snoozing and recurring task schedules.</p>
            </div>

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

            <div>
              <span className="block text-sm font-semibold text-[#303632]">Quick Snooze buttons</span>
              <p className="mt-1 text-sm leading-6 text-[#69716c]">Choose four different times. They always appear shortest-to-longest; Custom remains available for an exact date and time.</p>
              <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
                {settings.snoozeQuickPresets.map((preset, index) => (
                  <label key={`${index}-${preset}`} className="block">
                    <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-[#7a827d]">Slot {index + 1}</span>
                    <select
                      value={preset}
                      onChange={(event) => updateQuickSnoozePreset(index, event.target.value as QuickSnoozePreset)}
                      aria-label={`Quick Snooze slot ${index + 1}`}
                      className="h-12 w-full rounded-xl border border-black/[0.1] bg-white px-3 text-[16px] outline-none transition focus:border-[#216e4e]/60 focus:ring-3 focus:ring-[#216e4e]/10"
                    >
                      {QUICK_SNOOZE_OPTIONS.map((option) => (
                        <option
                          key={option.value}
                          value={option.value}
                          disabled={settings.snoozeQuickPresets.some((selected, selectedIndex) => selectedIndex !== index && selected === option.value)}
                        >
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
            </div>

            <section aria-labelledby="ai-preferences-title" className="border-t border-black/[0.07] pt-5">
              <div className="flex items-start gap-3">
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[#eaf3ed] text-[#216e4e]"><ActionIcon name="assistant" className="h-5 w-5" /></span>
                <div className="min-w-0 flex-1">
                  <h2 id="ai-preferences-title" className="text-lg font-semibold tracking-[-0.02em] text-[#202522]">AI preferences</h2>
                  <p className="mt-1 text-sm leading-6 text-[#69716c]">These preferences apply to the text assistant, browser Talk, and phone Talk when relevant.</p>
                </div>
              </div>

              <label className="mt-5 block">
                <span className="mb-2 block text-sm font-semibold text-[#303632]">Realtime voice</span>
                <select
                  value={settings.realtimeVoice}
                  onChange={(event) => {
                    const realtimeVoice = event.target.value as RealtimeVoice;
                    setSettings((current) => ({ ...current, realtimeVoice }));
                    setSaved(false);
                    console.info("[todo-ai-preferences] Realtime voice preference changed", { realtimeVoice });
                  }}
                  className="h-12 w-full rounded-xl border border-black/[0.1] bg-white px-3 text-[16px] outline-none transition focus:border-[#216e4e]/60 focus:ring-3 focus:ring-[#216e4e]/10"
                >
                  {REALTIME_VOICE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}{option.recommended ? " · recommended" : ""}
                    </option>
                  ))}
                </select>
                <p className="mt-1.5 text-xs leading-5 text-[#7c847f]">Used for new browser and phone Talk sessions. An active conversation keeps its current voice until the next session.</p>
              </label>
            </section>
          </fieldset>

          <div className="mt-6 rounded-xl bg-[#f1f6f3] px-4 py-3 text-sm leading-6 text-[#4f6257]">
            Snoozing hides a task until {hourLabel(settings.snoozeWakeHour)} on the next calendar day. Recurring cron schedules are also evaluated in {timeZones.find(([zone]) => zone === settings.snoozeTimeZone)?.[1] ?? settings.snoozeTimeZone}.
          </div>

          {message && <p role="alert" className="mt-4 text-sm text-red-700">{message}</p>}

          <div className="mt-6 flex items-center gap-3">
            <button type="submit" disabled={loading || saving} className="rounded-xl bg-[#216e4e] px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-[#195d41] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#216e4e] disabled:opacity-50">
              {saving ? "Saving…" : "Save preferences"}
            </button>
            {saved && <span role="status" className="text-sm font-medium text-[#216e4e]">Saved</span>}
          </div>
        </form>

        <section aria-labelledby="talk-phone-title" className="mt-6 rounded-2xl border border-black/[0.07] bg-white p-5 shadow-[0_10px_35px_rgba(30,45,36,0.06)] sm:p-7">
          <div className="flex items-start gap-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[#eaf3ed] text-[#216e4e]"><ActionIcon name="phone" className="h-5 w-5" /></span>
            <div className="min-w-0 flex-1">
              <h2 id="talk-phone-title" className="text-lg font-semibold tracking-[-0.02em] text-[#202522]">Call Talk</h2>
              <p className="mt-1 text-sm leading-6 text-[#69716c]">Call the same realtime chief-of-staff assistant from any phone. Enter your private PIN before the assistant can read or change tasks.</p>
            </div>
          </div>

          {talkPhoneLoading ? (
            <div role="status" aria-label="Loading phone access" className="mt-5 h-28 animate-pulse rounded-xl bg-[#f1f3f0]" />
          ) : (
            <>
              <div className="mt-4 rounded-xl bg-[#f1f6f3] px-4 py-3 text-sm leading-6 text-[#4f6257]">
                {!talkPhoneProfile?.providerReady
                  ? "Twilio credentials are not configured on this site."
                  : talkPhoneProfile.configured
                    ? <>Enabled. Call <a className="font-semibold text-[#216e4e] underline decoration-[#216e4e]/30 underline-offset-2" href={`tel:${talkPhoneProfile.phoneNumber}`}>{talkPhoneProfile.phoneNumber}</a> and enter your PIN. Starting a phone call takes over any active browser Talk session.</>
                    : "Set a 6 to 8 digit PIN to connect the configured Twilio number."}
              </div>

              <form onSubmit={saveTalkPhonePin} className="mt-5 flex min-w-0 flex-col gap-2 sm:flex-row">
                <label className="min-w-0 flex-1">
                  <span className="sr-only">{talkPhoneProfile?.configured ? "New phone PIN" : "Phone PIN"}</span>
                  <input
                    value={talkPhonePin}
                    onChange={(event) => setTalkPhonePin(event.target.value.replace(/\D/g, "").slice(0, 8))}
                    type="password"
                    inputMode="numeric"
                    pattern="[0-9]{6,8}"
                    minLength={6}
                    maxLength={8}
                    autoComplete="new-password"
                    placeholder={talkPhoneProfile?.configured ? "New 6–8 digit PIN" : "6–8 digit PIN"}
                    className="h-11 w-full min-w-0 rounded-xl border border-black/[0.1] px-3 text-[16px] outline-none focus:border-[#216e4e]/50 focus:ring-3 focus:ring-[#216e4e]/10"
                  />
                </label>
                <button
                  type="submit"
                  disabled={talkPhoneSaving || !talkPhoneProfile?.providerReady || !/^\d{6,8}$/.test(talkPhonePin)}
                  className="inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-xl bg-[#216e4e] px-4 text-sm font-semibold text-white hover:bg-[#195d41] disabled:opacity-50"
                >
                  <ActionIcon name="phone" />
                  {talkPhoneSaving ? "Connecting…" : talkPhoneProfile?.configured ? "Change PIN" : "Enable phone access"}
                </button>
              </form>

              {talkPhoneProfile?.configured && (
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void reconnectTalkPhone()}
                    disabled={talkPhoneSaving}
                    className={compactOutlineActionClass}
                  >
                    <ActionIcon name="retry" />
                    Reconnect number
                  </button>
                  <button
                    type="button"
                    onClick={() => void disableTalkPhone()}
                    disabled={talkPhoneSaving}
                    className="inline-flex h-10 appearance-none items-center gap-2 rounded-xl border-0 bg-white px-3.5 text-sm font-semibold text-red-700 ring-1 ring-black/[0.06] transition hover:bg-red-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-700 disabled:opacity-50"
                  >
                    <ActionIcon name="delete" />
                    Disable
                  </button>
                </div>
              )}

              {talkPhoneProfile?.lastAuthenticatedAt && (
                <p className="mt-3 text-xs leading-5 text-[#8a918d]">
                  Last authenticated call {new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(talkPhoneProfile.lastAuthenticatedAt))}
                </p>
              )}
              {talkPhoneMessage && (
                <p role="status" className={`mt-3 text-sm ${/could not|not configured|choose/i.test(talkPhoneMessage) ? "text-red-700" : "text-[#216e4e]"}`}>{talkPhoneMessage}</p>
              )}
            </>
          )}
        </section>

        <section aria-labelledby="push-notifications-title" className="mt-6 rounded-2xl border border-black/[0.07] bg-white p-5 shadow-[0_10px_35px_rgba(30,45,36,0.06)] sm:p-7">
          <div className="flex items-start gap-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[#eaf3ed] text-[#216e4e]"><ActionIcon name="badge" className="h-5 w-5" /></span>
            <div className="min-w-0 flex-1">
              <h2 id="push-notifications-title" className="text-lg font-semibold tracking-[-0.02em] text-[#202522]">Push notifications</h2>
              <p className="mt-1 text-sm leading-6 text-[#69716c]">Get one batched alert when tasks wake from snooze, recur, or are added from another device or agent.</p>
            </div>
          </div>

          <div className="mt-4 rounded-xl bg-[#f1f6f3] px-4 py-3 text-sm leading-6 text-[#4f6257]">
            {pushState === "checking"
              ? "Checking notification support…"
              : pushState === "unsupported"
                ? "Push is unavailable here. On iPhone or iPad, add Dawar Todo to the Home Screen and open the installed app."
                : pushState === "unconfigured"
                  ? "Push delivery is not configured on the server yet."
                  : pushState === "blocked"
                    ? "Notifications are blocked for Dawar Todo in this device’s settings."
                    : pushState === "enabled"
                      ? "Enabled on this device. Tasks that wake together are combined into one alert within a minute."
                      : "Disabled on this device."}
          </div>

          {pushState === "enabled" ? (
            <button
              type="button"
              onClick={() => void disablePushNotifications()}
              disabled={updatingPush}
              className="mt-4 inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-white px-4 text-sm font-semibold text-[#4f5c55] ring-1 ring-black/[0.1] transition hover:bg-[#f4f6f4] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#216e4e] disabled:opacity-45"
            >
              <ActionIcon name="badge" />
              {updatingPush ? "Disabling…" : "Disable notifications"}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void enablePushNotifications()}
              disabled={updatingPush || pushState === "checking" || pushState === "unsupported" || pushState === "unconfigured" || pushState === "blocked"}
              className="mt-4 inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-[#216e4e] px-4 text-sm font-semibold text-white transition hover:bg-[#195d41] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#216e4e] disabled:cursor-not-allowed disabled:opacity-45"
            >
              <ActionIcon name="badge" />
              {updatingPush ? "Enabling…" : pushState === "blocked" ? "Permission blocked" : "Enable notifications"}
            </button>
          )}
        </section>

        <section aria-labelledby="app-badge-title" className="mt-6 rounded-2xl border border-black/[0.07] bg-white p-5 shadow-[0_10px_35px_rgba(30,45,36,0.06)] sm:p-7">
          <div className="flex items-start gap-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[#eaf3ed] text-[#216e4e]"><ActionIcon name="badge" className="h-5 w-5" /></span>
            <div className="min-w-0 flex-1">
              <h2 id="app-badge-title" className="text-lg font-semibold tracking-[-0.02em] text-[#202522]">App icon badge</h2>
              <p className="mt-1 text-sm leading-6 text-[#69716c]">Show the current Open-task count on the installed app icon. The badge updates whenever the app loads, syncs, or changes tasks.</p>
            </div>
          </div>

          <div className="mt-4 rounded-xl bg-[#f1f6f3] px-4 py-3 text-sm leading-6 text-[#4f6257]">
            {badgeSupported === null
              ? "Checking badge support…"
              : !badgeSupported
                ? "Native badges are not available in this browser. On iPhone and iPad, open Dawar Todo from its Home Screen icon."
                : badgeRequiresPermission
                  ? badgePermission === "granted"
                    ? "Badge permission is enabled."
                    : badgePermission === "denied"
                      ? "Badge permission is blocked in device notification settings."
                      : "iPhone and iPad require notification permission to display an icon badge."
                  : "This installed browser supports native app-icon badges. No additional permission is required."}
          </div>

          <button
            type="button"
            onClick={() => void enableAppBadge()}
            disabled={!badgeSupported || updatingBadge || (badgeRequiresPermission && badgePermission === "denied")}
            className="mt-4 inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-[#216e4e] px-4 text-sm font-semibold text-white transition hover:bg-[#195d41] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#216e4e] disabled:cursor-not-allowed disabled:opacity-45"
          >
            <ActionIcon name="badge" />
            {updatingBadge ? "Updating…" : badgeRequiresPermission && badgePermission === "denied" ? "Permission blocked" : badgeRequiresPermission && badgePermission !== "granted" ? "Enable app badge" : "Refresh app badge"}
          </button>
        </section>

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
