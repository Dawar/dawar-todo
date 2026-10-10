import { getTodoSettings, updateTodoSettings, type TodoSettings } from "../../../db/todos";
import { normalizeRealtimeVoice } from "../../../lib/ai-preferences";
import { parseOpeningTab } from "../../../lib/app-preferences";
import { parseQuickSnoozePresets } from "../../../lib/snooze-presets";

export async function GET() {
  const startedAt = Date.now();
  try {
    const settings = await getTodoSettings();
    console.info("[todo-api] settings loaded", { ...settings, durationMs: Date.now() - startedAt });
    return Response.json({ settings });
  } catch (error) {
    console.error("[todo-api] settings load failed", error);
    return Response.json({ error: "Your preferences could not be loaded." }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  try {
    const payload: unknown = await request.json().catch(() => null);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return Response.json({ error: "Send a preferences object." }, { status: 400 });
    }
    const patch: Partial<Omit<TodoSettings, "openAppToUpdatedAt">> = {};
    if ("snoozeTimeZone" in payload) {
      try {
        if (typeof payload.snoozeTimeZone !== "string" || !payload.snoozeTimeZone) throw new Error();
        new Intl.DateTimeFormat("en", { timeZone: payload.snoozeTimeZone }).format();
        patch.snoozeTimeZone = payload.snoozeTimeZone;
      } catch {
        return Response.json({ error: "Choose a valid time zone." }, { status: 400 });
      }
    }
    if ("snoozeWakeHour" in payload) {
      const hour = Number(payload.snoozeWakeHour);
      if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
        return Response.json({ error: "Choose a wake-up hour between 12 AM and 11 PM." }, { status: 400 });
      }
      patch.snoozeWakeHour = hour;
    }
    if ("snoozeQuickPresets" in payload) {
      const presets = parseQuickSnoozePresets(payload.snoozeQuickPresets);
      if (!presets) return Response.json({ error: "Choose four different Quick Snooze times between 15 minutes and 6 months." }, { status: 400 });
      patch.snoozeQuickPresets = presets;
    }
    if ("realtimeVoice" in payload) {
      const voice = normalizeRealtimeVoice(payload.realtimeVoice);
      if (!voice) return Response.json({ error: "Choose a supported Realtime voice." }, { status: 400 });
      patch.realtimeVoice = voice;
    }
    if ("openAppTo" in payload) {
      const tab = parseOpeningTab(payload.openAppTo);
      if (!tab) return Response.json({ error: "Choose Tasks or Bots for Open app to." }, { status: 400 });
      patch.openAppTo = tab;
    }
    const settings = await updateTodoSettings(patch);
    console.info("[todo-api] settings saved", { fields: Object.keys(patch) });
    return Response.json({ settings });
  } catch (error) {
    console.error("[todo-api] settings save failed", error);
    return Response.json({ error: "Your preferences could not be saved." }, { status: 500 });
  }
}
