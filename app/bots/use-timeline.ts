"use client";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { botsClient } from "./client";
import { BotTimeline } from "./timeline-controller";
import { registerPwaUpdateGuard } from "../pwa-update";

const timelines = new Map<string, BotTimeline>();
let listening = false, lastOwner = "";
function listen() {
  if (listening) return;
  listening = true;
  registerPwaUpdateGuard("conversation-position", async () => {
    await Promise.all([...timelines.values()].filter(timeline => timeline.owner === botsClient.owner).map(timeline => timeline.flushForUpdate()));
  });
  const flush = () => { for (const timeline of timelines.values()) void timeline.flush(); };
  botsClient.events.add((event) => {
    for (const timeline of timelines.values()) if (timeline.owner === botsClient.owner) timeline.receive(event);
  });
  botsClient.subscribe(() => {
    for (const timeline of timelines.values()) if (timeline.owner === botsClient.owner && botsClient.snapshot?.activeScheduledTurns)
      timeline.scheduled(botsClient.snapshot.activeScheduledTurns);
    if (lastOwner === botsClient.owner) return;
    lastOwner = botsClient.owner;
    for (const [key, timeline] of timelines) if (timeline.owner !== lastOwner) {
      timelines.delete(key); void timeline.dispose();
    }
  });
  window.addEventListener("pagehide", flush);
  window.addEventListener("dawar-before-navigation", flush);
  document.addEventListener("visibilitychange", () => { if (document.hidden) flush(); });
}
export function getBotTimeline(owner: string, botId: string) {
  listen();
  const key = JSON.stringify([owner, botId]);
  let timeline = timelines.get(key);
  if (!timeline) { timeline = new BotTimeline(owner, botId, botsClient); timelines.set(key, timeline); }
  else { timelines.delete(key); timelines.set(key, timeline); }
  // Retain recent navigation targets, not every bot in a large sidebar.
  if (timelines.size > 12) {
    const oldest = timelines.keys().next().value!;
    const evicted = timelines.get(oldest)!; timelines.delete(oldest); void evicted.dispose();
  }
  if (owner === botsClient.owner && botsClient.snapshot?.activeScheduledTurns) timeline.scheduled(botsClient.snapshot.activeScheduledTurns);
  return timeline;
}
export function useBotTimeline(owner: string, botId: string, online: boolean) {
  const timeline = useMemo(() => getBotTimeline(owner, botId), [owner, botId]);
  const state = useSyncExternalStore(timeline.subscribe, timeline.getSnapshot, timeline.getSnapshot);
  useEffect(() => {
    let active = true;
    let checkedAt = 0;
    const observation = () => {
      const bot = botsClient.snapshot?.bots.find(bot => bot.id === botId);
      return bot ? JSON.stringify([bot.threadId, bot.updatedAt]) : "";
    };
    let observed = observation(), pendingObservation = false;
    const current = () => active && botsClient.owner === owner;
    const checkLatest = () => {
      if (!current() || !botsClient.online || document.hidden || !pendingObservation && Date.now() - checkedAt < 10_000) return;
      pendingObservation = false;
      checkedAt = Date.now();
      void timeline.refreshLatest();
    };
    // A fresh sidebar snapshot can arrive without the corresponding native
    // events after suspension/reconnect. Heal the selected conversation too.
    const unsubscribe = botsClient.subscribe(() => {
      if (!current()) return;
      const next = observation();
      if (!next || next === observed) return;
      observed = next; pendingObservation = true;
      if (botsClient.online && !document.hidden) { pendingObservation = false; timeline.invalidateLatest(); }
    });
    window.addEventListener("focus", checkLatest);
    window.addEventListener("pageshow", checkLatest);
    document.addEventListener("visibilitychange", checkLatest);
    void (async () => {
      await timeline.hydrate();
      if (!timeline.getSnapshot().cached) {
        const legacy = await botsClient.cachedHistory(botId);
        if (active && botsClient.owner === owner && legacy) timeline.seed(legacy.turns, legacy.attachments);
      }
      if (current()) { checkedAt = Date.now(); await timeline.refreshLatest(); }
    })();
    return () => {
      active = false; unsubscribe();
      window.removeEventListener("focus", checkLatest);
      window.removeEventListener("pageshow", checkLatest);
      document.removeEventListener("visibilitychange", checkLatest);
      void timeline.flush();
    };
  }, [timeline, owner, botId, online]);
  return { timeline, state };
}
