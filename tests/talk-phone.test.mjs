import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { appAccessResponse } from "../worker/access.ts";

const root = new URL("../", import.meta.url);

test("ships a PIN-gated Twilio bridge into the shared Talk runtime", async () => {
  const [
    schema,
    database,
    phoneDb,
    twilio,
    stream,
    worker,
    access,
    settings,
    profileRoute,
    incomingRoute,
    verifyRoute,
    bridgeStartRoute,
    sipBridgeStartRoute,
    bridgeEventsRoute,
    bridgeRuntime,
    relay,
    sipController,
    relayConfig,
    environment,
  ] = await Promise.all([
    readFile(new URL("db/schema.ts", root), "utf8"),
    readFile(new URL("db/todos.ts", root), "utf8"),
    readFile(new URL("db/talk-phone.ts", root), "utf8"),
    readFile(new URL("lib/twilio-phone.ts", root), "utf8"),
    readFile(new URL("worker/talk-phone-stream.ts", root), "utf8"),
    readFile(new URL("worker/index.ts", root), "utf8"),
    readFile(new URL("worker/access.ts", root), "utf8"),
    readFile(new URL("app/settings/page.tsx", root), "utf8"),
    readFile(new URL("app/api/talk/phone/profile/route.ts", root), "utf8"),
    readFile(new URL("app/api/talk/phone/incoming/route.ts", root), "utf8"),
    readFile(new URL("app/api/talk/phone/verify/route.ts", root), "utf8"),
    readFile(new URL("app/api/talk/phone/bridge/start/route.ts", root), "utf8"),
    readFile(new URL("app/api/talk/phone/bridge/sip/start/route.ts", root), "utf8"),
    readFile(new URL("app/api/talk/phone/bridge/events/route.ts", root), "utf8"),
    readFile(new URL("lib/talk-phone-bridge.ts", root), "utf8"),
    readFile(new URL("voice-relay/src/index.ts", root), "utf8"),
    readFile(new URL("voice-relay/src/sip-controller.ts", root), "utf8"),
    readFile(new URL("voice-relay/wrangler.jsonc", root), "utf8"),
    readFile(new URL(".env.example", root), "utf8"),
  ]);

  assert.match(schema, /todoTalkPhoneProfiles/);
  assert.match(schema, /todoTalkPhoneCalls/);
  assert.match(database, /CURRENT_SCHEMA_VERSION = "24"/);
  assert.match(database, /CREATE TABLE IF NOT EXISTS todo_talk_phone_profiles/);
  assert.match(database, /CREATE TABLE IF NOT EXISTS todo_talk_phone_calls/);

  assert.match(phoneDb, /PBKDF2/);
  assert.match(phoneDb, /SHA-256/);
  assert.match(phoneDb, /PIN_ITERATIONS = 100_000/);
  assert.match(phoneDb, /MAX_SUPPORTED_PIN_ITERATIONS = 100_000/);
  assert.match(phoneDb, /unsupported PIN hash iteration count/);
  assert.match(phoneDb, /MAX_PIN_ATTEMPTS = 3/);
  assert.match(phoneDb, /stream_token_consumed_at IS NULL/);
  assert.match(phoneDb, /connectTalkPhoneSip/);
  assert.match(phoneDb, /provider_call_id/);
  assert.match(phoneDb, /authenticateTalkPhoneBridge/);
  assert.match(phoneDb, /'-70 minutes'/);
  assert.doesNotMatch(phoneDb, /console\.(?:info|warn|error)\([^)]*pin_hash/);

  assert.match(twilio, /x-twilio-signature/);
  assert.match(twilio, /HMAC/);
  assert.match(twilio, /SHA-1/);
  assert.match(twilio, /<Gather input="dtmf"/);
  assert.match(twilio, /<Connect><Stream/);
  assert.match(twilio, /<Dial answerOnBridge="true" timeout="20"><Sip>/);
  assert.match(twilio, /sip\.api\.openai\.com;transport=tls/);
  assert.match(twilio, /x-dawar-call-sid/);
  assert.match(twilio, /TWILIO_PHONE_TRANSPORT/);
  assert.match(twilio, /TWILIO_MEDIA_STREAM_URL/);
  assert.match(twilio, /secure WebSocket transport/);
  assert.match(twilio, /IncomingPhoneNumbers/);
  assert.match(twilio, /VoiceUrl/);

  assert.match(stream, /WebSocketPair/);
  assert.match(stream, /\/v1\/realtime/);
  assert.match(stream, /OpenAI-Project/);
  assert.match(stream, /OpenAI-Safety-Identifier/);
  assert.match(stream, /format: \{ type: "audio\/pcmu" \}/);
  assert.match(stream, /response\.output_audio\.delta/);
  assert.match(stream, /input_audio_buffer\.append/);
  assert.match(stream, /event: "clear"/);
  assert.match(stream, /talkInstructions\(context\)/);
  assert.match(stream, /talkToolDefinitions/);
  assert.match(stream, /dispatchTalkTool/);
  assert.match(stream, /startTalkSession/);
  assert.match(stream, /appendTalkMessage/);
  assert.match(stream, /PHONE_IDLE_LIMIT_MS = 15 \* 60 \* 1_000/);
  assert.match(stream, /REALTIME_ROLLOVER_MS = 50 \* 60 \* 1_000/);
  assert.match(stream, /TWILIO_START_TIMEOUT_MS = 15_000/);
  assert.match(stream, /deferring to one-time token/);
  assert.match(stream, /consumeTalkPhoneStream/);
  assert.doesNotMatch(stream, /stream signature rejected[\s\S]{0,160}return new Response\("Forbidden"/);
  assert.doesNotMatch(stream, /console\.(?:info|warn|error)\([^;]*\{\s*(?:audio|transcript|rawToken)\s*:/);
  assert.match(worker, /handleTalkPhoneStream/);

  assert.match(access, /\/api\/talk\/phone\/incoming/);
  assert.match(access, /\/api\/talk\/phone\/verify/);
  assert.match(access, /\/api\/talk\/phone\/stream/);
  assert.match(access, /\/api\/talk\/phone\/bridge\//);
  assert.match(profileRoute, /talkUserKey/);
  assert.match(profileRoute, /configureTwilioVoiceWebhook/);
  assert.match(incomingRoute, /validateTwilioRequest/);
  assert.match(verifyRoute, /findTalkPhoneUserByPin/);
  assert.match(verifyRoute, /talkPhoneMediaStreamUrl/);
  assert.match(verifyRoute, /phoneSipTwiml/);
  assert.match(verifyRoute, /talkPhoneTransport/);
  assert.match(bridgeStartRoute, /consumeTalkPhoneStream/);
  assert.match(bridgeStartRoute, /mintRealtimeClientSecret/);
  assert.match(bridgeStartRoute, /audioFormat: "pcmu"/);
  assert.match(sipBridgeStartRoute, /connectTalkPhoneSip/);
  assert.match(sipBridgeStartRoute, /realtimeSessionConfig/);
  assert.match(sipBridgeStartRoute, /talkInstructions\(context\)/);
  assert.match(bridgeEventsRoute, /audioFormat: "pcmu"/);
  assert.match(
    await readFile(new URL("lib/talk-runtime.ts", root), "utf8"),
    /format: \{ type: "audio\/pcmu" \}/,
  );
  assert.match(bridgeEventsRoute, /dispatchTalkTool/);
  assert.match(bridgeEventsRoute, /appendTalkMessage/);
  assert.match(bridgeEventsRoute, /action === "rollover"/);
  assert.match(bridgeRuntime, /authenticateTalkPhoneBridge/);
  assert.match(relay, /new WebSocket\(url/);
  assert.match(relay, /openai-insecure-api-key/);
  assert.match(relay, /input_audio_buffer\.append/);
  assert.match(relay, /response\.output_audio\.delta/);
  assert.match(relay, /bridgeRequest/);
  assert.match(relay, /handleOpenAISipWebhook/);
  assert.match(relay, /SipCallController/);
  assert.match(sipController, /realtime\.call\.incoming/);
  assert.match(sipController, /\/v1\/realtime\/calls\/\$\{encodeURIComponent\(bridge\.providerCallId\)\}\/accept/);
  assert.match(sipController, /call_id/);
  assert.match(sipController, /DurableObjectState/);
  assert.match(sipController, /twilio-openai-sip/);
  assert.match(sipController, /OPENAI_API_KEY/);
  assert.match(sipController, /PHONE_IDLE_LIMIT_MS = 15 \* 60 \* 1_000/);
  assert.doesNotMatch(sipController, /console\.(?:info|warn|error)\([^;]*\{\s*(?:token|transcript|apiKey)\s*:/);
  assert.match(relayConfig, /SIP_CONTROLLERS/);
  assert.match(relayConfig, /new_sqlite_classes/);
  assert.doesNotMatch(relayConfig, /OPENAI_API_KEY|TWILIO_AUTH_TOKEN|DB/);
  assert.match(relayConfig, /SITE_BASE_URL/);
  assert.match(settings, /Call Talk/);
  assert.match(settings, /6 to 8 digit PIN/);
  assert.match(settings, /Starting a phone call takes over any active browser Talk session/);
  assert.doesNotMatch(settings, /TWILIO_AUTH_TOKEN|OPENAI_API_KEY/);
  assert.match(environment, /OPENAI_PROJECT_ID=/);
  assert.match(environment, /TWILIO_ACCOUNT_SID=/);
  assert.match(environment, /TWILIO_AUTH_TOKEN=/);
  assert.match(environment, /TWILIO_PHONE_NUMBER=/);
  assert.match(environment, /TWILIO_MEDIA_STREAM_URL=/);
  assert.match(environment, /TWILIO_PHONE_TRANSPORT=media/);
});

test("phone migration preserves existing tasks and creates call security tables", async () => {
  const migration = await readFile(new URL("drizzle/0021_mature_zemo.sql", root), "utf8");
  const database = new DatabaseSync(":memory:");
  database.exec("CREATE TABLE todos (id INTEGER PRIMARY KEY, title TEXT NOT NULL); INSERT INTO todos VALUES (1, 'Existing');");
  for (const statement of migration.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) {
    database.exec(statement);
  }
  assert.equal(database.prepare("SELECT title FROM todos WHERE id = 1").get().title, "Existing");
  for (const table of ["todo_talk_phone_profiles", "todo_talk_phone_calls"]) {
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?").get(table).count, 1);
  }
  for (const index of [
    "todo_talk_phone_calls_user_idx",
    "todo_talk_phone_calls_source_idx",
    "todo_talk_phone_calls_status_idx",
    "todo_talk_phone_calls_stream_idx",
  ]) {
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'index' AND name = ?").get(index).count, 1);
  }
});

test("direct SIP migration preserves calls and adds provider routing metadata", async () => {
  const initial = await readFile(new URL("drizzle/0021_mature_zemo.sql", root), "utf8");
  const migration = await readFile(new URL("drizzle/0022_rich_madame_hydra.sql", root), "utf8");
  const database = new DatabaseSync(":memory:");
  for (const statement of initial.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) {
    database.exec(statement);
  }
  database.prepare(`
    INSERT INTO todo_talk_phone_calls (call_sid, from_number_hash, to_number)
    VALUES (?, ?, ?)
  `).run(`CA${"a".repeat(32)}`, "caller-hash", "+15555550100");
  for (const statement of migration.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) {
    database.exec(statement);
  }
  const call = database.prepare(`
    SELECT transport, provider_call_id
    FROM todo_talk_phone_calls
    WHERE call_sid = ?
  `).get(`CA${"a".repeat(32)}`);
  assert.equal(call.transport, "media");
  assert.equal(call.provider_call_id, null);
  assert.equal(
    database.prepare(`
      SELECT COUNT(*) AS count
      FROM sqlite_master
      WHERE type = 'index' AND name = 'todo_talk_phone_calls_provider_idx'
    `).get().count,
    1,
  );
});

test("only Twilio transport webhooks are public; phone profile remains signed-in only", async () => {
  for (const path of [
    "/api/talk/phone/incoming",
    "/api/talk/phone/verify",
    "/api/talk/phone/stream",
    "/api/talk/phone/bridge/start",
    "/api/talk/phone/bridge/events",
  ]) {
    assert.equal(await appAccessResponse(new Request(`https://work.dawar.ca${path}`), { DB: {} }), null);
  }
  const bearer = `Bearer dt_live_${"A".repeat(43)}`;
  const profileResponse = await appAccessResponse(new Request("https://work.dawar.ca/api/talk/phone/profile", {
    headers: { Authorization: bearer },
  }), { DB: {} });
  assert.equal(profileResponse?.status, 403);
  assert.match(await profileResponse.text(), /signed-in Dawar Todo interface/);
});
