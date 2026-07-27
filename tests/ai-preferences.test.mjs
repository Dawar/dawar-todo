import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  DEFAULT_REALTIME_VOICE,
  REALTIME_VOICES,
  normalizeRealtimeVoice,
} from "../lib/ai-preferences.ts";

const root = new URL("../", import.meta.url);

test("Realtime voice preferences use the supported OpenAI voice allowlist", () => {
  assert.equal(DEFAULT_REALTIME_VOICE, "marin");
  assert.deepEqual(REALTIME_VOICES, [
    "marin",
    "cedar",
    "alloy",
    "ash",
    "ballad",
    "coral",
    "echo",
    "sage",
    "shimmer",
    "verse",
  ]);
  assert.equal(normalizeRealtimeVoice(" Cedar "), "cedar");
  assert.equal(normalizeRealtimeVoice("unsupported"), null);
});

test("AI preferences persist centrally and apply to browser and phone Talk", async () => {
  const [
    settingsPage,
    settingsRoute,
    database,
    runtime,
    browserTalk,
    phoneBridge,
    sipBridge,
    phoneEvents,
    phoneWorker,
    openApiText,
    skill,
  ] = await Promise.all([
    readFile(new URL("app/settings/page.tsx", root), "utf8"),
    readFile(new URL("app/api/settings/route.ts", root), "utf8"),
    readFile(new URL("db/todos.ts", root), "utf8"),
    readFile(new URL("lib/talk-runtime.ts", root), "utf8"),
    readFile(new URL("app/api/talk/sessions/route.ts", root), "utf8"),
    readFile(new URL("app/api/talk/phone/bridge/start/route.ts", root), "utf8"),
    readFile(new URL("app/api/talk/phone/bridge/sip/start/route.ts", root), "utf8"),
    readFile(new URL("app/api/talk/phone/bridge/events/route.ts", root), "utf8"),
    readFile(new URL("worker/talk-phone-stream.ts", root), "utf8"),
    readFile(new URL("public/openapi.json", root), "utf8"),
    readFile(new URL("db/api-token-skill.ts", root), "utf8"),
  ]);
  const openApi = JSON.parse(openApiText);

  assert.match(settingsPage, />Preferences</);
  assert.match(settingsPage, />AI preferences</);
  assert.match(settingsPage, />Realtime voice</);
  assert.match(settingsPage, /REALTIME_VOICE_OPTIONS/);
  assert.match(settingsPage, /new browser and phone Talk sessions/);
  assert.match(settingsRoute, /Choose a supported Realtime voice/);
  assert.match(database, /ai_realtime_voice/);
  assert.match(database, /settings\.realtimeVoice/);
  assert.match(runtime, /talkRuntimeConfig\(input\.voice\)/);
  assert.match(browserTalk, /talkRuntimeConfig\(settings\.realtimeVoice\)/);
  assert.match(browserTalk, /voice,/);
  assert.match(phoneBridge, /talkRuntimeConfig\(settings\.realtimeVoice\)/);
  assert.match(sipBridge, /talkRuntimeConfig\(settings\.realtimeVoice\)/);
  assert.match(phoneEvents, /voice: settings\.realtimeVoice/);
  assert.match(phoneWorker, /realtimeVoice = settings\.realtimeVoice/);
  assert.deepEqual(openApi.components.schemas.Settings.properties.realtimeVoice.enum, [...REALTIME_VOICES]);
  assert.match(skill, /realtimeVoice/);
});
