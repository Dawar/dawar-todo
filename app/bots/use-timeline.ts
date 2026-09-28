"use client";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { botsClient } from "./client";
import { BotTimeline } from "./timeline-controller";

const timelines = new Map<string, BotTimeline>();
let listening = false, lastOwner = "";
function listen() {
  if (listening) return;
  listening = true;
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
    void (async () => {
      await timeline.hydrate();
      if (!timeline.getSnapshot().cached) {
        const legacy = await botsClient.cachedHistory(botId);
        if (active && botsClient.owner === owner && legacy) timeline.seed(legacy.turns, legacy.attachments);
      }
      if (active && botsClient.owner === owner) await timeline.refresh();
    })();
    return () => { active = false; void timeline.flush(); };
  }, [timeline, owner, botId, online]);
  return { timeline, state };
}
