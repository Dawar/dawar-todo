import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  nextUrgentAttemptAt,
  URGENT_WAVE_DELAYS_MS,
  urgentWaveDelayMs,
} from "../lib/urgent-alert-schedule.ts";

const root = new URL("../", import.meta.url);

test("uses the requested progressive urgent-alert cadence", () => {
  assert.deepEqual(
    URGENT_WAVE_DELAYS_MS.map((delay) => delay / 60_000),
    [2, 3, 5, 10, 10, 30, 60, 120, 240, 960, 1440],
  );
  const cumulative = [];
  let total = 0;
  for (let wave = 0; wave < 11; wave += 1) {
    total += urgentWaveDelayMs(wave) / 60_000;
    cumulative.push(total);
  }
  assert.deepEqual(cumulative, [2, 5, 10, 20, 30, 60, 120, 240, 480, 1440, 2880]);
  assert.equal(urgentWaveDelayMs(99), 24 * 60 * 60 * 1_000);
});

test("first-hour waves bypass the call window and later waves defer", () => {
  const lateToronto = new Date("2026-08-15T03:30:00.000Z"); // 11:30 PM Toronto
  const rapid = nextUrgentAttemptAt(4, lateToronto, {
    timeZone: "America/Toronto",
    callWindowStart: 8,
    callWindowEnd: 22,
  });
  assert.equal(rapid.toISOString(), "2026-08-15T03:40:00.000Z");

  const later = nextUrgentAttemptAt(6, lateToronto, {
    timeZone: "America/Toronto",
    callWindowStart: 8,
    callWindowEnd: 22,
  });
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(later);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  assert.equal(values.hour, "08");
  assert.equal(values.minute, "00");
});

test("ships durable agent-origin escalation, profile phone, callbacks, and owner controls", async () => {
  const [schema, database, access, todosRoute, urgentDb, profileDb, settings, twilio, openApiText, environment] = await Promise.all([
    readFile(new URL("db/schema.ts", root), "utf8"),
    readFile(new URL("db/todos.ts", root), "utf8"),
    readFile(new URL("worker/access.ts", root), "utf8"),
    readFile(new URL("app/api/todos/route.ts", root), "utf8"),
    readFile(new URL("db/urgent-alerts.ts", root), "utf8"),
    readFile(new URL("db/profile-phone.ts", root), "utf8"),
    readFile(new URL("app/settings/page.tsx", root), "utf8"),
    readFile(new URL("lib/twilio-phone.ts", root), "utf8"),
    readFile(new URL("public/openapi.json", root), "utf8"),
    readFile(new URL(".env.example", root), "utf8"),
  ]);
  const openApi = JSON.parse(openApiText);

  assert.match(schema, /todoProfileContacts/);
  assert.match(schema, /todoProfilePhoneVerifications/);
  assert.match(schema, /todoUrgentEscalations/);
  assert.match(schema, /todoUrgentAttempts/);
  assert.match(database, /CURRENT_SCHEMA_VERSION = "30"/);
  assert.match(database, /CREATE TABLE IF NOT EXISTS todo_urgent_escalations/);
  assert.match(database, /todo_urgent_escalations_due_idx/);
  assert.match(database, /task and campaign committed atomically/);
  assert.match(database, /INSERT INTO todo_urgent_escalations[\s\S]*FROM todos WHERE client_id = \?/);

  assert.match(access, /INTERNAL_ACTOR_HEADERS/);
  assert.match(access, /request\.headers\.delete/);
  assert.match(access, /INTERNAL_ACTOR_USER_KEY_HEADER/);
  assert.match(access, /owner-only urgent acknowledgement rejected/);
  assert.match(todosRoute, /apiTokenActorFromRequest/);
  assert.match(todosRoute, /priority === 1/);
  assert.match(todosRoute, /urgentAlert: apiActor/);
  assert.match(todosRoute, /createUrgentAlertCampaign/);
  assert.match(todosRoute, /processUrgentAlertQueue/);

  assert.match(profileDb, /AES-GCM/);
  assert.match(profileDb, /TODO_PROFILE_PHONE_KEY/);
  assert.match(profileDb, /MAX_VERIFICATION_ATTEMPTS = 5/);
  assert.doesNotMatch(profileDb, /console\.(?:info|warn|error)\([^;]*(?:phoneNumber|phone_ciphertext|codeHash)/);
  assert.match(urgentDb, /lease_expires_at/);
  assert.match(urgentDb, /state = 'blocked_configuration'/);
  assert.match(urgentDb, /taskStillRequiresAlert/);
  assert.match(urgentDb, /activeVoiceAttempt/);
  assert.match(urgentDb, /acknowledgeUrgentAlertForTodo/);
  assert.match(urgentDb, /"urgency-lowered"/);
  assert.match(urgentDb, /"pinned"/);
  assert.match(urgentDb, /"snoozed"/);
  assert.match(urgentDb, /"completed"/);
  assert.match(urgentDb, /urgent\/provider\/sms\/status/);
  assert.match(urgentDb, /urgent\/provider\/voice\?attempt=/);
  assert.match(urgentDb, /\?task=\$\{campaign\.todo_id\}/);

  assert.match(twilio, /Messages\.json/);
  assert.match(twilio, /Calls\.json/);
  assert.match(twilio, /MachineDetection/);
  assert.match(twilio, /StatusCallbackEvent/);
  assert.match(settings, /Profile phone/);
  assert.match(settings, /Send test call \+ text/);
  assert.match(settings, /Copy alert diagnostics/);
  assert.match(environment, /TODO_PROFILE_PHONE_KEY/);
  assert.match(environment, /TODO_PUBLIC_URL/);

  assert.equal(openApi.info.version, "1.4.0");
  assert.ok(openApi.components.schemas.UrgentAlert);
  assert.ok(openApi.paths["/api/todos"].post.responses["201"].content["application/json"].schema.properties.urgentAlert);

  for (const path of [
    "app/api/talk/phone/urgent/provider/sms/incoming/route.ts",
    "app/api/talk/phone/urgent/provider/sms/status/route.ts",
    "app/api/talk/phone/urgent/provider/voice/route.ts",
    "app/api/talk/phone/urgent/provider/voice/action/route.ts",
    "app/api/talk/phone/urgent/provider/voice/status/route.ts",
  ]) {
    const source = await readFile(new URL(path, root), "utf8");
    assert.match(source, /validateTwilioRequest/);
  }
});
