"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { ExecutionMachines } from "./execution-machines";
import { AccountSession } from "./account-session";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { NativeSelect } from "@/components/ui/native-select";
import { ActionIcon } from "../action-icon";
import {
  appleMobileBadgeRequiresNotificationPermission,
  currentOpenTaskCount,
  supportsNativeAppBadge,
  updateNativeAppBadge,
} from "../app-badge";
import { copyTextToClipboard } from "../copy-to-clipboard";
import { getOrCreateDeviceId, headersWithDeviceId } from "../device-id";
import { ensureCurrentPushSubscription } from "../push-client";
import { SiteHeader } from "../site-header";
import { cacheOpeningTab, cachedOpeningTab } from "../opening-preference";
import { DEFAULT_OPENING_TAB, parseOpeningTab, type OpeningTab } from "../../lib/app-preferences";
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
  openAppTo: OpeningTab;
  openAppToUpdatedAt?: string | null;
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

type ProfilePhone = {
  configured: boolean;
  maskedPhoneNumber: string | null;
  phoneVerifiedAt: string | null;
  urgentAlertsEnabled: boolean;
  callWindowStart: number;
  callWindowEnd: number;
  providerReady: boolean;
  voiceReady: boolean;
  smsReady: boolean;
  updatedAt: string | null;
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

const compactOutlineActionClass = buttonVariants({ variant: "outline" });

function hourLabel(hour: number) {
  if (hour === 0) return "12:00 AM";
  if (hour < 12) return `${hour}:00 AM`;
  if (hour === 12) return "12:00 PM";
  return `${hour - 12}:00 PM`;
}

function pushCapabilityAvailable() {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
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
    openAppTo: DEFAULT_OPENING_TAB,
    snoozeTimeZone: "America/Toronto",
    snoozeWakeHour: 8,
    snoozeQuickPresets: DEFAULT_QUICK_SNOOZE_PRESETS,
    realtimeVoice: DEFAULT_REALTIME_VOICE,
  });
  const changedSettings = useRef(new Set<keyof Settings>());
  const settingsLoadGeneration = useRef(0);
  const settingsReadController = useRef<AbortController | null>(null);
  const settingsSaveInFlight = useRef(false);
  const settingsLoadError = useRef("");
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
  const [testingPush, setTestingPush] = useState(false);
  const [talkPhoneProfile, setTalkPhoneProfile] = useState<TalkPhoneProfile | null>(null);
  const [talkPhonePin, setTalkPhonePin] = useState("");
  const [talkPhoneLoading, setTalkPhoneLoading] = useState(true);
  const [talkPhoneSaving, setTalkPhoneSaving] = useState(false);
  const [talkPhoneMessage, setTalkPhoneMessage] = useState("");
  const [profilePhone, setProfilePhone] = useState<ProfilePhone | null>(null);
  const [profilePhoneInput, setProfilePhoneInput] = useState("");
  const [profilePhoneChallenge, setProfilePhoneChallenge] = useState<{ challengeId: string; maskedPhoneNumber: string; expiresAt: string } | null>(null);
  const [profilePhoneCode, setProfilePhoneCode] = useState("");
  const [profilePhoneLoading, setProfilePhoneLoading] = useState(true);
  const [profilePhoneSaving, setProfilePhoneSaving] = useState(false);
  const [profilePhoneTesting, setProfilePhoneTesting] = useState(false);
  const [profilePhoneMessage, setProfilePhoneMessage] = useState("");

  useEffect(() => {
    // Activity can resume during PATCH. Defer the GET until settlement, rather
    // than capturing a pre-commit snapshot that could later overwrite Saved.
    if (settingsSaveInFlight.current) return;
    let active = true;
    const generation = ++settingsLoadGeneration.current;
    const controller = new AbortController();
    settingsReadController.current = controller;
    const currentLoad = () => active && generation === settingsLoadGeneration.current && !settingsSaveInFlight.current;
    const timeout = window.setTimeout(() => controller.abort(), 15_000);
    request<{ settings: Settings }>("/api/settings", { signal: controller.signal, cache: "no-store" })
      .then(({ settings: loaded }) => {
        if (!currentLoad()) return;
        const previousLoadError = settingsLoadError.current;
        settingsLoadError.current = "";
        if (previousLoadError) setMessage((current) => current === previousLoadError ? "" : current);
        setSettings((current) => {
          if (!currentLoad()) return current;
          const next: Settings = {
            ...loaded,
            openAppTo: parseOpeningTab(loaded.openAppTo) ?? cachedOpeningTab() ?? DEFAULT_OPENING_TAB,
            snoozeQuickPresets: loaded.snoozeQuickPresets ?? DEFAULT_QUICK_SNOOZE_PRESETS,
            realtimeVoice: loaded.realtimeVoice ?? DEFAULT_REALTIME_VOICE,
          };
          // Returning to this Activity reruns effects. Keep any unsaved fields
          // while refreshing the rest instead of replacing the form draft.
          return { ...next, ...Object.fromEntries([...changedSettings.current].map((key) => [key, current[key]])) };
        });
        cacheOpeningTab(loaded.openAppTo, loaded.openAppToUpdatedAt);
        console.info("[todo-ui] settings loaded", loaded);
      })
      .catch((error: Error) => {
        if (!currentLoad()) return;
        if (!changedSettings.current.has("openAppTo")) setSettings((current) => currentLoad() ? { ...current, openAppTo: cachedOpeningTab() ?? DEFAULT_OPENING_TAB } : current);
        settingsLoadError.current = controller.signal.aborted ? "Loading preferences timed out. Your edits are kept; reopen Settings to retry." : error.message;
        setMessage(settingsLoadError.current);
      })
      .finally(() => {
        window.clearTimeout(timeout);
        if (currentLoad()) setLoading(false);
      });
    return () => {
      active = false;
      if (settingsReadController.current === controller) settingsReadController.current = null;
      controller.abort();
      window.clearTimeout(timeout);
    };
  }, [saving]);

  useEffect(() => {
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

    request<{ profilePhone: ProfilePhone }>("/api/talk/phone/profile-number", { cache: "no-store" })
      .then(({ profilePhone: loadedProfilePhone }) => {
        setProfilePhone(loadedProfilePhone);
        console.info("[todo-profile-phone-ui] profile phone loaded", {
          configured: loadedProfilePhone.configured,
          urgentAlertsEnabled: loadedProfilePhone.urgentAlertsEnabled,
          providerReady: loadedProfilePhone.providerReady,
        });
      })
      .catch((error: Error) => setProfilePhoneMessage(error.message))
      .finally(() => setProfilePhoneLoading(false));

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
          const config = await request<{
            configured: boolean;
            publicKey: string | null;
            subscribed: boolean;
            subscription?: {
              active: boolean;
              failureCount: number;
              lastSuccessAt: string | null;
              lastFailureStatus: number | null;
            } | null;
          }>("/api/push", {
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
          let subscription = await registration.pushManager.getSubscription();
          const unhealthy = Boolean(
            config.subscription
            && (!config.subscription.active || config.subscription.failureCount > 0),
          );
          if (subscription && unhealthy) {
            const repaired = await ensureCurrentPushSubscription(registration, config.publicKey, { forceRenew: true });
            subscription = repaired.subscription;
          }
          if (!subscription && Notification.permission === "granted") {
            const restored = await ensureCurrentPushSubscription(registration, config.publicKey);
            subscription = restored.subscription;
          }
          if (subscription && (!config.subscribed || unhealthy)) {
            await request("/api/push", {
              method: "POST",
              body: JSON.stringify({ ...subscription.toJSON(), deviceId: getOrCreateDeviceId() }),
            });
            console.info("[todo-push] browser subscription restored on server", {
              repairedServerFailure: unhealthy,
            });
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
    if (settingsSaveInFlight.current || loading) return;
    settingsSaveInFlight.current = true;
    settingsLoadGeneration.current++;
    settingsReadController.current?.abort();
    setLoading(false);
    setSaving(true);
    setSaved(false);
    settingsLoadError.current = "";
    setMessage("");
    try {
      const { settings: persisted } = await request<{ settings: Settings }>("/api/settings", {
        method: "PATCH",
        body: JSON.stringify(Object.fromEntries([...changedSettings.current].map((key) => [key, settings[key]]))),
      });
      // Fence reads again at acknowledgement, including any Activity-resume
      // work queued while the mutation was pending, before clearing dirty keys.
      settingsLoadGeneration.current++;
      settingsReadController.current?.abort();
      setSettings({ ...persisted, openAppTo: parseOpeningTab(persisted.openAppTo) ?? settings.openAppTo });
      changedSettings.current.clear();
      setSaved(true);
      if (!cacheOpeningTab(persisted.openAppTo, persisted.openAppToUpdatedAt)) setMessage("Preferences saved online, but this browser could not remember the opening tab offline. Retry Save preferences when browser storage is available.");
      console.info("[todo-ui] settings saved", persisted);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Settings could not be saved.");
    } finally {
      settingsLoadGeneration.current++;
      settingsReadController.current?.abort();
      settingsSaveInFlight.current = false;
      setLoading(false);
      setSaving(false);
    }
  }

  function updateQuickSnoozePreset(index: number, value: QuickSnoozePreset) {
    changedSettings.current.add("snoozeQuickPresets");
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
      if (pushCapabilityAvailable() && Notification.permission === "granted") {
        let publicKey = pushPublicKey;
        if (!publicKey) {
          const config = await request<{ configured: boolean; publicKey: string | null }>("/api/push", { cache: "no-store" });
          if (config.configured && config.publicKey) {
            publicKey = config.publicKey;
            setPushPublicKey(publicKey);
          }
        }
        if (publicKey) {
          const registration = await navigator.serviceWorker.ready;
          const { subscription } = await ensureCurrentPushSubscription(registration, publicKey);
          await request("/api/push", {
            method: "POST",
            body: JSON.stringify({ ...subscription.toJSON(), deviceId: getOrCreateDeviceId() }),
          });
          setPushState("enabled");
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
      const health = await request<{
        subscription?: { active: boolean; failureCount: number } | null;
      }>("/api/push", { cache: "no-store" });
      const unhealthy = Boolean(health.subscription && (!health.subscription.active || health.subscription.failureCount > 0));
      const { subscription, reused, renewed } = await ensureCurrentPushSubscription(
        registration,
        publicKey,
        { forceRenew: unhealthy },
      );
      await request("/api/push", {
        method: "POST",
        body: JSON.stringify({ ...subscription.toJSON(), deviceId: getOrCreateDeviceId() }),
      });
      setPushState("enabled");
      setShareNotice({ tone: "success", text: "Push notifications enabled on this device." });
      console.info("[todo-push] notifications enabled", {
        reusedBrowserSubscription: reused,
        renewedBrowserSubscription: renewed,
        repairedServerFailure: unhealthy,
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

  async function testPushNotifications() {
    if (testingPush || pushState !== "enabled") return;
    setTestingPush(true);
    setShareNotice(null);
    try {
      await request<{ sent: true; status: number }>("/api/push", { method: "PATCH" });
      setShareNotice({ tone: "success", text: "Test notification sent to this device." });
    } catch (error) {
      const health = await request<{
        subscribed: boolean;
        subscription?: { active: boolean } | null;
      }>("/api/push", { cache: "no-store" }).catch(() => null);
      const stillEnabled = Boolean(health?.subscribed && health.subscription?.active);
      setPushState(stillEnabled ? "enabled" : "disabled");
      setShareNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "The test notification failed.",
      });
      console.error("[todo-push] test notification failed", {
        browserSubscriptionStillEnabled: stillEnabled,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setTestingPush(false);
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

  async function requestProfilePhoneVerification(event: FormEvent) {
    event.preventDefault();
    if (!profilePhoneInput.trim()) return;
    setProfilePhoneSaving(true);
    setProfilePhoneMessage("");
    try {
      const { verification } = await request<{ verification: { challengeId: string; maskedPhoneNumber: string; expiresAt: string } }>("/api/talk/phone/profile-number/verification", {
        method: "POST",
        body: JSON.stringify({ phoneNumber: profilePhoneInput }),
      });
      setProfilePhoneChallenge(verification);
      setProfilePhoneCode("");
      setProfilePhoneMessage(`Verification code sent to ${verification.maskedPhoneNumber}.`);
      console.info("[todo-profile-phone-ui] verification requested", {
        challengeId: verification.challengeId,
        expiresAt: verification.expiresAt,
      });
    } catch (error) {
      setProfilePhoneMessage(error instanceof Error ? error.message : "The verification text could not be sent.");
    } finally {
      setProfilePhoneSaving(false);
    }
  }

  async function confirmProfilePhone(event: FormEvent) {
    event.preventDefault();
    if (!profilePhoneChallenge || !/^\d{6}$/.test(profilePhoneCode)) return;
    setProfilePhoneSaving(true);
    setProfilePhoneMessage("");
    try {
      const { profilePhone: verified } = await request<{ profilePhone: ProfilePhone }>("/api/talk/phone/profile-number/verification", {
        method: "PUT",
        body: JSON.stringify({ challengeId: profilePhoneChallenge.challengeId, code: profilePhoneCode }),
      });
      setProfilePhone(verified);
      setProfilePhoneChallenge(null);
      setProfilePhoneInput("");
      setProfilePhoneCode("");
      setProfilePhoneMessage("Profile phone verified. Urgent agent calls and texts are enabled.");
      console.info("[todo-profile-phone-ui] profile phone verified", {
        urgentAlertsEnabled: verified.urgentAlertsEnabled,
        callWindowStart: verified.callWindowStart,
        callWindowEnd: verified.callWindowEnd,
      });
    } catch (error) {
      setProfilePhoneMessage(error instanceof Error ? error.message : "The profile phone could not be verified.");
    } finally {
      setProfilePhoneSaving(false);
    }
  }

  async function saveProfilePhonePreferences(next?: Partial<Pick<ProfilePhone, "urgentAlertsEnabled" | "callWindowStart" | "callWindowEnd">>) {
    if (!profilePhone) return;
    setProfilePhoneSaving(true);
    setProfilePhoneMessage("");
    const desired = { ...profilePhone, ...next };
    try {
      const { profilePhone: persisted } = await request<{ profilePhone: ProfilePhone }>("/api/talk/phone/profile-number", {
        method: "PATCH",
        body: JSON.stringify({
          urgentAlertsEnabled: desired.urgentAlertsEnabled,
          callWindowStart: desired.callWindowStart,
          callWindowEnd: desired.callWindowEnd,
        }),
      });
      setProfilePhone(persisted);
      setProfilePhoneMessage(persisted.urgentAlertsEnabled ? "Urgent alert preferences saved." : "Urgent agent calls and texts disabled.");
    } catch (error) {
      setProfilePhoneMessage(error instanceof Error ? error.message : "Profile phone preferences could not be saved.");
    } finally {
      setProfilePhoneSaving(false);
    }
  }

  async function removeProfilePhone() {
    if (!window.confirm("Remove your verified profile phone? This also stops every active urgent alert.")) return;
    setProfilePhoneSaving(true);
    setProfilePhoneMessage("");
    try {
      const { profilePhone: cleared } = await request<{ profilePhone: ProfilePhone }>("/api/talk/phone/profile-number", { method: "DELETE" });
      setProfilePhone(cleared);
      setProfilePhoneChallenge(null);
      setProfilePhoneMessage("Profile phone removed.");
    } catch (error) {
      setProfilePhoneMessage(error instanceof Error ? error.message : "The profile phone could not be removed.");
    } finally {
      setProfilePhoneSaving(false);
    }
  }

  async function testProfilePhone() {
    setProfilePhoneTesting(true);
    setProfilePhoneMessage("");
    try {
      await request("/api/talk/phone/profile-number/test", { method: "POST" });
      setProfilePhoneMessage("Test call and text sent.");
    } catch (error) {
      setProfilePhoneMessage(error instanceof Error ? error.message : "The test call and text could not be sent.");
    } finally {
      setProfilePhoneTesting(false);
    }
  }

  return (
    <main className="min-h-screen bg-background text-foreground">
      <SiteHeader current="settings" />
      <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6 sm:py-12">
        <div className="mb-7">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Settings</h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">Control task timing, AI behavior, and device features.</p>
        </div>

        <AccountSession />
        <ExecutionMachines />
        <form onSubmit={save} className="rounded-lg border border-border bg-card p-5 shadow-sm sm:p-7">
          <fieldset disabled={loading || saving} className="space-y-5 disabled:opacity-60">
            <section aria-labelledby="opening-preference-title" className="border-b border-border pb-5">
              <h2 id="opening-preference-title" className="text-lg font-semibold tracking-[-0.02em] text-foreground">App opening</h2>
              <label className="mt-4 block">
                <span className="mb-2 block text-sm font-semibold text-foreground">Open app to</span>
                <NativeSelect value={settings.openAppTo}
                  onChange={(event) => {
                    changedSettings.current.add("openAppTo");
                    setSettings((current) => ({ ...current, openAppTo: event.target.value as OpeningTab }));
                    setSaved(false);
                  }}
                  aria-describedby="opening-preference-help"
                  >
                  <option value="tasks">Tasks</option>
                  <option value="bots">Bots</option>
                </NativeSelect>
              </label>
              <p id="opening-preference-help" className="mt-1.5 text-xs leading-5 text-muted-foreground">Used for a fresh app launch, including offline after saving on this device. Links and an already-open screen keep their destination.</p>
            </section>
            <div>
              <h2 className="text-lg font-semibold tracking-[-0.02em] text-foreground">Daily review</h2>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">Choose the timezone for snoozing and recurring task schedules.</p>
            </div>

            <label className="block">
              <span className="mb-2 block text-sm font-semibold text-foreground">Time zone</span>
              <NativeSelect
                value={settings.snoozeTimeZone}
                onChange={(event) => { changedSettings.current.add("snoozeTimeZone"); setSettings((current) => ({ ...current, snoozeTimeZone: event.target.value })); setSaved(false); }}

              >
                {timeZones.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </NativeSelect>
            </label>

            <label className="block">
              <span className="mb-2 block text-sm font-semibold text-foreground">Wake-up time</span>
              <NativeSelect
                value={settings.snoozeWakeHour}
                onChange={(event) => { changedSettings.current.add("snoozeWakeHour"); setSettings((current) => ({ ...current, snoozeWakeHour: Number(event.target.value) })); setSaved(false); }}

              >
                {Array.from({ length: 24 }, (_, hour) => <option key={hour} value={hour}>{hourLabel(hour)}</option>)}
              </NativeSelect>
            </label>

            <div>
              <span className="block text-sm font-semibold text-foreground">Quick Snooze buttons</span>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">Choose four different times. They always appear shortest-to-longest; Custom remains available for an exact date and time.</p>
              <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
                {settings.snoozeQuickPresets.map((preset, index) => (
                  <label key={`${index}-${preset}`} className="block">
                    <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">Slot {index + 1}</span>
                    <NativeSelect
                      value={preset}
                      onChange={(event) => updateQuickSnoozePreset(index, event.target.value as QuickSnoozePreset)}
                      aria-label={`Quick Snooze slot ${index + 1}`}

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
                    </NativeSelect>
                  </label>
                ))}
              </div>
            </div>

            <section aria-labelledby="ai-preferences-title" className="border-t border-border pt-5">
              <div className="flex items-start gap-3">
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-accent text-primary"><ActionIcon name="assistant" className="h-5 w-5" /></span>
                <div className="min-w-0 flex-1">
                  <h2 id="ai-preferences-title" className="text-lg font-semibold tracking-[-0.02em] text-foreground">AI preferences</h2>
                  <p className="mt-1 text-sm leading-6 text-muted-foreground">These preferences apply to the text assistant, browser Talk, and phone Talk when relevant.</p>
                </div>
              </div>

              <label className="mt-5 block">
                <span className="mb-2 block text-sm font-semibold text-foreground">Realtime voice</span>
                <NativeSelect
                  value={settings.realtimeVoice}
                  onChange={(event) => {
                    const realtimeVoice = event.target.value as RealtimeVoice;
                    changedSettings.current.add("realtimeVoice");
                    setSettings((current) => ({ ...current, realtimeVoice }));
                    setSaved(false);
                    console.info("[todo-ai-preferences] Realtime voice preference changed", { realtimeVoice });
                  }}

                >
                  {REALTIME_VOICE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}{option.recommended ? " · recommended" : ""}
                    </option>
                  ))}
                </NativeSelect>
                <p className="mt-1.5 text-xs leading-5 text-muted-foreground">Used for new browser and phone Talk sessions. An active conversation keeps its current voice until the next session.</p>
              </label>
            </section>
          </fieldset>

          <div className="mt-6 rounded-lg bg-muted px-4 py-3 text-sm leading-6 text-muted-foreground">
            Snoozing hides a task until {hourLabel(settings.snoozeWakeHour)} on the next calendar day. Recurring cron schedules are also evaluated in {timeZones.find(([zone]) => zone === settings.snoozeTimeZone)?.[1] ?? settings.snoozeTimeZone}.
          </div>

          {message && <p role="alert" className="mt-4 text-sm text-destructive">{message}</p>}

          <div className="mt-6 flex items-center gap-3">
            <Button variant="default" type="submit" disabled={loading || saving}>
              {saving ? "Saving…" : "Save preferences"}
            </Button>
            {saved && <span role="status" className="text-sm font-medium text-primary">Saved</span>}
          </div>
        </form>

        <section aria-labelledby="profile-phone-title" className="mt-6 rounded-lg border border-border bg-card p-5 shadow-sm sm:p-7">
          <div className="flex items-start gap-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-accent text-primary"><ActionIcon name="phone" className="h-5 w-5" /></span>
            <div className="min-w-0 flex-1">
              <h2 id="profile-phone-title" className="text-lg font-semibold tracking-[-0.02em] text-foreground">Profile phone</h2>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">Save one verified phone number for your profile. Dawar Todo uses it for urgent tasks created by your API agents, and it can support other profile features later.</p>
            </div>
          </div>

          {profilePhoneLoading ? (
            <div role="status" aria-label="Loading profile phone" className="mt-5 h-32 animate-pulse rounded-lg bg-muted" />
          ) : !profilePhone?.configured ? (
            <>
              <div className="mt-4 rounded-lg bg-muted px-4 py-3 text-sm leading-6 text-muted-foreground">
                {!profilePhone?.providerReady
                  ? "Twilio delivery and profile-phone encryption must be configured before a number can be verified."
                  : "Your number is encrypted after verification. Only its final four digits appear here."}
              </div>
              {!profilePhoneChallenge ? (
                <form onSubmit={requestProfilePhoneVerification} className="mt-5 flex min-w-0 flex-col gap-2 sm:flex-row">
                  <label className="min-w-0 flex-1">
                    <span className="sr-only">Profile phone number</span>
                    <Input
                      value={profilePhoneInput}
                      onChange={(event) => setProfilePhoneInput(event.target.value)}
                      type="tel"
                      inputMode="tel"
                      autoComplete="tel"
                      placeholder="+1 416 555 0123"

                    />
                  </label>
                  <Button variant="default" type="submit" disabled={profilePhoneSaving || !profilePhone?.providerReady || !profilePhoneInput.trim()} className="shrink-0">
                    <ActionIcon name="phone" />
                    {profilePhoneSaving ? "Sending…" : "Text verification code"}
                  </Button>
                </form>
              ) : (
                <form onSubmit={confirmProfilePhone} className="mt-5">
                  <p className="text-sm leading-6 text-muted-foreground">Enter the code sent to {profilePhoneChallenge.maskedPhoneNumber}.</p>
                  <div className="mt-2 flex min-w-0 flex-col gap-2 sm:flex-row">
                    <label className="min-w-0 flex-1">
                      <span className="sr-only">Verification code</span>
                      <Input
                        value={profilePhoneCode}
                        onChange={(event) => setProfilePhoneCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        pattern="[0-9]{6}"
                        placeholder="6-digit code"
                        className="tracking-[0.2em]"
                      />
                    </label>
                    <Button variant="default" type="submit" disabled={profilePhoneSaving || !/^\d{6}$/.test(profilePhoneCode)} className="shrink-0">
                      <ActionIcon name="done" />
                      {profilePhoneSaving ? "Verifying…" : "Verify number"}
                    </Button>
                    <Button variant="outline" type="button" onClick={() => setProfilePhoneChallenge(null)} disabled={profilePhoneSaving}>Change number</Button>
                  </div>
                </form>
              )}
            </>
          ) : (
            <>
              <div className="mt-4 rounded-lg bg-muted px-4 py-3 text-sm leading-6 text-muted-foreground">
                Verified profile phone <span className="font-semibold text-foreground">{profilePhone.maskedPhoneNumber}</span>. Every new priority-1 task created with an API token starts a call-and-text escalation.
              </div>
              <label className="mt-5 flex items-center justify-between gap-4 rounded-lg border border-border bg-muted/40 px-4 py-3">
                <span>
                  <span className="block text-sm font-semibold text-foreground">Urgent agent calls and texts</span>
                  <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">Disabling this stops every active campaign. Re-enabling applies to future tasks.</span>
                </span>
                <input
                  type="checkbox"
                  checked={profilePhone.urgentAlertsEnabled}
                  disabled={profilePhoneSaving}
                  onChange={(event) => void saveProfilePhonePreferences({ urgentAlertsEnabled: event.target.checked })}
                  className="h-5 w-5 shrink-0 accent-primary"
                />
              </label>
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <label>
                  <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">Later-call window starts</span>
                  <NativeSelect value={profilePhone.callWindowStart} onChange={(event) => setProfilePhone((current) => current ? { ...current, callWindowStart: Number(event.target.value) } : current)}>
                    {Array.from({ length: 22 }, (_, hour) => hour).map((hour) => <option key={hour} value={hour}>{hourLabel(hour)}</option>)}
                  </NativeSelect>
                </label>
                <label>
                  <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">Later-call window ends</span>
                  <NativeSelect value={profilePhone.callWindowEnd} onChange={(event) => setProfilePhone((current) => current ? { ...current, callWindowEnd: Number(event.target.value) } : current)}>
                    {Array.from({ length: 23 }, (_, index) => index + 1).map((hour) => <option key={hour} value={hour}>{hour === 24 ? "12:00 AM" : hourLabel(hour)}</option>)}
                  </NativeSelect>
                </label>
              </div>
              <p className="mt-2 text-xs leading-5 text-muted-foreground">The first hour of an urgent campaign bypasses this window. Later calls and texts wait for the window in your task timezone.</p>
              <div className="mt-4 flex flex-wrap gap-2">
                <Button variant="default" type="button" onClick={() => void saveProfilePhonePreferences()} disabled={profilePhoneSaving || profilePhone.callWindowStart >= profilePhone.callWindowEnd}><ActionIcon name="done" />Save alert window</Button>
                <Button variant="outline" type="button" onClick={() => void testProfilePhone()} disabled={profilePhoneTesting || profilePhoneSaving}><ActionIcon name="phone" />{profilePhoneTesting ? "Sending…" : "Send test call + text"}</Button>
                <Button variant="outline" type="button" onClick={() => void removeProfilePhone()} disabled={profilePhoneSaving} className="text-destructive hover:bg-destructive/10 hover:text-destructive"><ActionIcon name="delete" />Remove number</Button>
              </div>
            </>
          )}
          {profilePhoneMessage && <p role="status" className={`mt-3 text-sm ${/could not|invalid|incorrect|expired|too many|not configured|choose/i.test(profilePhoneMessage) ? "text-destructive" : "text-primary"}`}>{profilePhoneMessage}</p>}
        </section>

        <section aria-labelledby="talk-phone-title" className="mt-6 rounded-lg border border-border bg-card p-5 shadow-sm sm:p-7">
          <div className="flex items-start gap-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-accent text-primary"><ActionIcon name="phone" className="h-5 w-5" /></span>
            <div className="min-w-0 flex-1">
              <h2 id="talk-phone-title" className="text-lg font-semibold tracking-[-0.02em] text-foreground">Call Operator</h2>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">Call the same realtime chief-of-staff assistant from any phone. Enter your private PIN before the assistant can read or change tasks.</p>
            </div>
          </div>

          {talkPhoneLoading ? (
            <div role="status" aria-label="Loading phone access" className="mt-5 h-28 animate-pulse rounded-lg bg-muted" />
          ) : (
            <>
              <div className="mt-4 rounded-lg bg-muted px-4 py-3 text-sm leading-6 text-muted-foreground">
                {!talkPhoneProfile?.providerReady
                  ? "Twilio credentials are not configured on this site."
                  : talkPhoneProfile.configured
                    ? <>Enabled. Call <a className="font-semibold text-primary underline decoration-primary/30 underline-offset-2" href={`tel:${talkPhoneProfile.phoneNumber}`}>{talkPhoneProfile.phoneNumber}</a> and enter your PIN. Starting a phone call takes over any active browser Operator call.</>
                    : "Set a 6 to 8 digit PIN to connect the configured Twilio number."}
              </div>

              <form onSubmit={saveTalkPhonePin} className="mt-5 flex min-w-0 flex-col gap-2 sm:flex-row">
                <label className="min-w-0 flex-1">
                  <span className="sr-only">{talkPhoneProfile?.configured ? "New phone PIN" : "Phone PIN"}</span>
                  <Input
                    value={talkPhonePin}
                    onChange={(event) => setTalkPhonePin(event.target.value.replace(/\D/g, "").slice(0, 8))}
                    type="password"
                    inputMode="numeric"
                    pattern="[0-9]{6,8}"
                    minLength={6}
                    maxLength={8}
                    autoComplete="new-password"
                    placeholder={talkPhoneProfile?.configured ? "New 6–8 digit PIN" : "6–8 digit PIN"}

                  />
                </label>
                <Button variant="default"
                  type="submit"
                  disabled={talkPhoneSaving || !talkPhoneProfile?.providerReady || !/^\d{6,8}$/.test(talkPhonePin)}
                  className="shrink-0"
                >
                  <ActionIcon name="phone" />
                  {talkPhoneSaving ? "Connecting…" : talkPhoneProfile?.configured ? "Change PIN" : "Enable phone access"}
                </Button>
              </form>

              {talkPhoneProfile?.configured && (
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button variant="outline"
                    type="button"
                    onClick={() => void reconnectTalkPhone()}
                    disabled={talkPhoneSaving}

                  >
                    <ActionIcon name="retry" />
                    Reconnect number
                  </Button>
                  <Button variant="outline"
                    type="button"
                    onClick={() => void disableTalkPhone()}
                    disabled={talkPhoneSaving}
                    className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                  >
                    <ActionIcon name="delete" />
                    Disable
                  </Button>
                </div>
              )}

              {talkPhoneProfile?.lastAuthenticatedAt && (
                <p className="mt-3 text-xs leading-5 text-muted-foreground">
                  Last authenticated call {new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(talkPhoneProfile.lastAuthenticatedAt))}
                </p>
              )}
              {talkPhoneMessage && (
                <p role="status" className={`mt-3 text-sm ${/could not|not configured|choose/i.test(talkPhoneMessage) ? "text-destructive" : "text-primary"}`}>{talkPhoneMessage}</p>
              )}
            </>
          )}
        </section>

        <section aria-labelledby="push-notifications-title" className="mt-6 rounded-lg border border-border bg-card p-5 shadow-sm sm:p-7">
          <div className="flex items-start gap-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-accent text-primary"><ActionIcon name="badge" className="h-5 w-5" /></span>
            <div className="min-w-0 flex-1">
              <h2 id="push-notifications-title" className="text-lg font-semibold tracking-[-0.02em] text-foreground">Push notifications</h2>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">Get one batched alert when tasks wake from snooze, recur, or are added from another device or agent.</p>
            </div>
          </div>

          <div className="mt-4 rounded-lg bg-muted px-4 py-3 text-sm leading-6 text-muted-foreground">
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
            <div className="mt-4 flex flex-wrap gap-2">
              <Button variant="default"
                type="button"
                onClick={() => void testPushNotifications()}
                disabled={testingPush || updatingPush}

              >
                <ActionIcon name="badge" />
                {testingPush ? "Sending…" : "Send test"}
              </Button>
              <Button variant="outline"
                type="button"
                onClick={() => void disablePushNotifications()}
                disabled={updatingPush || testingPush}

              >
                <ActionIcon name="badge" />
                {updatingPush ? "Disabling…" : "Disable notifications"}
              </Button>
            </div>
          ) : (
            <Button variant="default"
              type="button"
              onClick={() => void enablePushNotifications()}
              disabled={updatingPush || pushState === "checking" || pushState === "unsupported" || pushState === "unconfigured" || pushState === "blocked"}
              className="mt-4"
            >
              <ActionIcon name="badge" />
              {updatingPush ? "Enabling…" : pushState === "blocked" ? "Permission blocked" : "Enable notifications"}
            </Button>
          )}
        </section>

        <section aria-labelledby="app-badge-title" className="mt-6 rounded-lg border border-border bg-card p-5 shadow-sm sm:p-7">
          <div className="flex items-start gap-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-accent text-primary"><ActionIcon name="badge" className="h-5 w-5" /></span>
            <div className="min-w-0 flex-1">
              <h2 id="app-badge-title" className="text-lg font-semibold tracking-[-0.02em] text-foreground">App icon badge</h2>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">Show the current Open-task count on the installed app icon. The badge updates whenever the app loads, syncs, or changes tasks.</p>
            </div>
          </div>

          <div className="mt-4 rounded-lg bg-muted px-4 py-3 text-sm leading-6 text-muted-foreground">
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

          <Button variant="default"
            type="button"
            onClick={() => void enableAppBadge()}
            disabled={!badgeSupported || updatingBadge || (badgeRequiresPermission && badgePermission === "denied")}
            className="mt-4"
          >
            <ActionIcon name="badge" />
            {updatingBadge ? "Updating…" : badgeRequiresPermission && badgePermission === "denied" ? "Permission blocked" : badgeRequiresPermission && badgePermission !== "granted" ? "Enable app badge" : "Refresh app badge"}
          </Button>
        </section>

        <section aria-labelledby="api-access-title" className="mt-6 rounded-lg border border-border bg-card p-5 shadow-sm sm:p-7">
          <div className="flex items-start gap-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-accent text-primary"><ActionIcon name="link" className="h-5 w-5" /></span>
            <div className="min-w-0">
              <h2 id="api-access-title" className="text-lg font-semibold tracking-[-0.02em] text-foreground">API access</h2>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">Create a personal Bearer token for agents and automations to manage your tasks, projects, attachments, and settings.</p>
            </div>
          </div>

          <div className="mt-4 rounded-lg bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-900">
            Tokens have full access to this todo database. Treat them like passwords. The token and its credentialed SKILL.md are available only when created, and every token can be revoked at any time.
          </div>

          <form onSubmit={createToken} className="mt-5 grid min-w-0 gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
            <label className="min-w-0">
              <span className="sr-only">Token name</span>
              <Input
                value={tokenName}
                onChange={(event) => setTokenName(event.target.value)}
                maxLength={80}
                placeholder="Token name"

              />
            </label>
            <label>
              <span className="sr-only">Token expiration</span>
              <NativeSelect value={tokenExpiration} onChange={(event) => setTokenExpiration(event.target.value)} className="sm:w-auto">
                <option value="30">30 days</option>
                <option value="90">90 days</option>
                <option value="365">1 year</option>
                <option value="never">Never expires</option>
              </NativeSelect>
            </label>
            <Button variant="default" type="submit" disabled={creatingToken || !tokenName.trim()}>
              <ActionIcon name="add" />
              {creatingToken ? "Generating…" : "Generate token"}
            </Button>
          </form>

          {createdToken && (
            <div className="mt-4 rounded-lg border border-primary/20 bg-accent p-3.5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-primary">Copy this token now</p>
                  <p className="mt-0.5 text-xs leading-5 text-muted-foreground">The raw token and credentialed SKILL.md are available only until you dismiss this panel.</p>
                </div>
                <Button size="icon" variant="ghost" type="button" onClick={() => setCreatedToken(null)} aria-label="Dismiss generated token" title="Dismiss" className="shrink-0"><ActionIcon name="close" /></Button>
              </div>
              <Textarea readOnly value={createdToken.token} onFocus={(event) => event.currentTarget.select()} aria-label="Generated API token" rows={2} className="mt-3 resize-none break-all font-mono" />
              <div className="mt-2 flex flex-wrap gap-2">
                <Button variant="outline" type="button" onClick={() => void copyApiToken()}><ActionIcon name="copy" />Copy token</Button>
                <Button variant="outline" type="button" onClick={() => void copyCreatedTokenSkill()}><ActionIcon name="copy" />Copy Skill</Button>
              </div>
            </div>
          )}

          <div className="mt-5 rounded-lg border border-border bg-muted/40 p-3.5">
            <p className="text-sm font-semibold text-foreground">Agent documentation</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">Use the public OpenAPI 3.1 specification to discover request bodies, responses, and Bearer authentication.</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <a href="/openapi.json" target="_blank" rel="noreferrer" className={compactOutlineActionClass}><ActionIcon name="link" />Open specification</a>
              <Button variant="outline" type="button" onClick={() => void copyOpenApiUrl()}><ActionIcon name="copy" />Copy OpenAPI URL</Button>
            </div>
          </div>

          <div className="mt-5 border-t border-border pt-5">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Active tokens</h3>
            {tokensLoading ? (
              <div role="status" aria-label="Loading API tokens" className="mt-3 space-y-3">
                {[0, 1].map((item) => <div key={item} className="h-24 animate-pulse rounded-lg bg-muted" />)}
              </div>
            ) : apiTokens.length ? (
              <ul className="mt-3 space-y-3">
                {apiTokens.map((apiToken) => (
                  <li key={apiToken.id} className="flex min-w-0 items-start justify-between gap-3 rounded-lg border border-border bg-muted/40 p-3.5">
                    <div className="min-w-0">
                      <p className="break-words text-sm font-semibold text-foreground">{apiToken.name}</p>
                      <p className="mt-1 font-mono text-xs text-muted-foreground">{apiToken.tokenPrefix}</p>
                      <p className="mt-1 text-xs leading-5 text-muted-foreground">
                        {apiToken.lastUsedAt ? `Last used ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(apiToken.lastUsedAt))}` : "Never used"}
                        {apiToken.expiresAt ? ` · Expires ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(apiToken.expiresAt))}` : " · Never expires"}
                      </p>
                    </div>
                    <Button variant="outline" type="button" onClick={() => void revokeToken(apiToken)} disabled={busyTokenId === apiToken.id} className="text-destructive hover:bg-destructive/10 hover:text-destructive shrink-0"><ActionIcon name="delete" />Revoke</Button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 rounded-lg border border-dashed border-border px-4 py-5 text-center text-sm text-muted-foreground">No active API tokens.</p>
            )}
          </div>
        </section>

        <section aria-labelledby="calendar-sharing-title" className="mt-6 rounded-lg border border-border bg-card p-5 shadow-sm sm:p-7">
          <div className="flex items-start gap-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-accent text-primary"><ActionIcon name="calendar" className="h-5 w-5" /></span>
            <div className="min-w-0">
              <h2 id="calendar-sharing-title" className="text-lg font-semibold tracking-[-0.02em] text-foreground">Calendar sharing</h2>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">Generate a secure, public iCal subscription containing every task with a due date. Calendar apps receive updates automatically.</p>
            </div>
          </div>

          <div className="mt-4 rounded-lg bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-900">
            Anyone with a link can read the titles, notes, project, context, status, and due dates in that feed. Regenerate or revoke a link whenever access should end.
          </div>

          <form onSubmit={createFeed} className="mt-5 flex min-w-0 flex-col gap-2 sm:flex-row">
            <label className="min-w-0 flex-1">
              <span className="sr-only">Calendar name</span>
              <Input
                value={calendarName}
                onChange={(event) => setCalendarName(event.target.value)}
                maxLength={80}
                placeholder="Calendar name"

              />
            </label>
            <Button variant="default" type="submit" disabled={creatingFeed || !calendarName.trim()} className="shrink-0">
              <ActionIcon name="link" />
              {creatingFeed ? "Generating…" : "Generate link"}
            </Button>
          </form>

          <div className="mt-5 border-t border-border pt-5">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Active links</h3>
            {feedsLoading ? (
              <div role="status" aria-label="Loading calendar links" className="mt-3 space-y-3">
                {[0, 1].map((item) => <div key={item} className="h-28 animate-pulse rounded-lg bg-muted" />)}
              </div>
            ) : calendarFeeds.length ? (
              <ul className="mt-3 space-y-3">
                {calendarFeeds.map((feed) => (
                  <li key={feed.id} className="min-w-0 rounded-lg border border-border bg-muted/40 p-3.5">
                    <div className="flex min-w-0 items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="break-words text-sm font-semibold text-foreground">{feed.name}</p>
                        <p className="mt-0.5 text-xs text-muted-foreground">Created {new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(feed.createdAt))}</p>
                      </div>
                      <Button size="icon" variant="ghost" type="button" onClick={() => void copyFeed(feed)} className="shrink-0" aria-label={`Copy ${feed.name} calendar link`} title="Copy link"><ActionIcon name="copy" /></Button>
                    </div>
                    <Input readOnly value={feed.url} onFocus={(event) => event.currentTarget.select()} aria-label={`${feed.name} public calendar URL`} className="mt-3 font-mono" />
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Button variant="outline" type="button" onClick={() => void copyFeed(feed)}><ActionIcon name="copy" />Copy link</Button>
                      <Button variant="outline" type="button" onClick={() => void regenerateFeed(feed)} disabled={busyFeedId === feed.id}><ActionIcon name="retry" />Regenerate</Button>
                      <Button variant="outline" type="button" onClick={() => void revokeFeed(feed)} disabled={busyFeedId === feed.id} className="text-destructive hover:bg-destructive/10 hover:text-destructive"><ActionIcon name="delete" />Revoke</Button>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 rounded-lg border border-dashed border-border px-4 py-5 text-center text-sm text-muted-foreground">No public calendar links yet.</p>
            )}
          </div>
        </section>
      </div>

      {shareNotice && (
        <div className="pointer-events-none fixed inset-x-0 bottom-[max(1rem,env(safe-area-inset-bottom))] z-[60] mx-auto w-[calc(100%-2rem)] max-w-md">
          <div role={shareNotice.tone === "error" ? "alert" : "status"} className={`pointer-events-auto flex min-h-14 items-center gap-3 rounded-lg px-4 py-3 text-sm text-primary-foreground shadow-[0_16px_50px_rgba(0,0,0,0.24)] ${shareNotice.tone === "error" ? "bg-destructive" : "bg-foreground"}`}>
            <span className="min-w-0 flex-1 font-medium">{shareNotice.text}</span>
            <Button size="icon" variant="ghost" type="button" onClick={() => setShareNotice(null)} aria-label="Dismiss notification" className="shrink-0 text-primary-foreground hover:bg-card/10 hover:text-primary-foreground"><ActionIcon name="close" /></Button>
          </div>
        </div>
      )}
    </main>
  );
}
