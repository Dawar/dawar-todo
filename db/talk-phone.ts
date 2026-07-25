import { env } from "cloudflare:workers";
import { ensureTodoDatabase } from "./todos";

// Cloudflare Workers' Web Crypto PBKDF2 implementation caps iteration counts
// at 100,000. Keep the stored value explicit so verification remains
// deterministic across browser, test, and production runtimes.
const PIN_ITERATIONS = 100_000;
const MAX_SUPPORTED_PIN_ITERATIONS = 100_000;
const MAX_PIN_ATTEMPTS = 3;
const STREAM_TOKEN_TTL_MS = 5 * 60 * 1_000;
const PHONE_BRIDGE_SESSION_TTL_MS = 70 * 60 * 1_000;

type PhoneProfileRow = {
  user_key: string;
  pin_hash: string;
  pin_salt: string;
  pin_iterations: number;
  enabled: number;
  webhook_url: string | null;
  provider_configured_at: string | null;
  pin_updated_at: string;
  last_authenticated_at: string | null;
  updated_at: string;
};

type PhoneCallRow = {
  call_sid: string;
  user_key: string | null;
  from_number_hash: string;
  to_number: string;
  status: string;
  attempt_count: number;
  stream_token_hash: string | null;
  stream_token_expires_at: string | null;
  stream_token_consumed_at: string | null;
  transport: string;
  provider_call_id: string | null;
  talk_session_id: string | null;
  started_at: string;
  authenticated_at: string | null;
  connected_at: string | null;
  ended_at: string | null;
  failure_reason: string | null;
};

function database(db?: D1Database) {
  const selected = db ?? env.DB;
  if (!selected) throw new Error("The todo database is unavailable.");
  return selected;
}

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function derivePinHash(pin: string, salt: Uint8Array, iterations: number) {
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > MAX_SUPPORTED_PIN_ITERATIONS) {
    console.warn("[todo-talk-phone] unsupported PIN hash iteration count", {
      iterations,
      maximum: MAX_SUPPORTED_PIN_ITERATIONS,
    });
    throw new Error("This phone PIN uses an unsupported hash format. Reset it in Settings.");
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(pin),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations },
    key,
    256,
  );
  return new Uint8Array(bits);
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return bytesToBase64Url(new Uint8Array(digest));
}

export function validTalkPhonePin(pin: string) {
  return /^\d{6,8}$/.test(pin);
}

export function validTwilioCallSid(callSid: string) {
  return /^CA[0-9a-f]{32}$/i.test(callSid);
}

export async function hashPhoneNumber(phoneNumber: string) {
  return sha256(`dawar-todo-phone:${phoneNumber.trim()}`);
}

export async function readTalkPhoneProfile(userKey: string, db?: D1Database) {
  await ensureTodoDatabase();
  const row = await database(db).prepare(`
    SELECT user_key, pin_hash, pin_salt, pin_iterations, enabled, webhook_url,
           provider_configured_at, pin_updated_at, last_authenticated_at, updated_at
    FROM todo_talk_phone_profiles
    WHERE user_key = ?
  `).bind(userKey).first<PhoneProfileRow>();
  return row ? {
    configured: Boolean(row.enabled),
    webhookUrl: row.webhook_url,
    providerConfiguredAt: row.provider_configured_at,
    pinUpdatedAt: row.pin_updated_at,
    lastAuthenticatedAt: row.last_authenticated_at,
    updatedAt: row.updated_at,
  } : {
    configured: false,
    webhookUrl: null,
    providerConfiguredAt: null,
    pinUpdatedAt: null,
    lastAuthenticatedAt: null,
    updatedAt: null,
  };
}

export async function setTalkPhonePin(userKey: string, pin: string, db?: D1Database) {
  if (!validTalkPhonePin(pin)) throw new Error("Choose a 6 to 8 digit phone PIN.");
  await ensureTodoDatabase();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derivePinHash(pin, salt, PIN_ITERATIONS);
  await database(db).prepare(`
    INSERT INTO todo_talk_phone_profiles (
      user_key, pin_hash, pin_salt, pin_iterations, enabled, pin_updated_at, updated_at
    ) VALUES (?, ?, ?, ?, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(user_key) DO UPDATE SET
      pin_hash = excluded.pin_hash,
      pin_salt = excluded.pin_salt,
      pin_iterations = excluded.pin_iterations,
      enabled = 1,
      pin_updated_at = excluded.pin_updated_at,
      updated_at = excluded.updated_at
  `).bind(
    userKey,
    bytesToBase64Url(hash),
    bytesToBase64Url(salt),
    PIN_ITERATIONS,
  ).run();
  console.info("[todo-talk-phone] phone PIN created or replaced", {
    userKey,
    digits: pin.length,
    iterations: PIN_ITERATIONS,
  });
  return readTalkPhoneProfile(userKey, db);
}

export async function disableTalkPhoneProfile(userKey: string, db?: D1Database) {
  await ensureTodoDatabase();
  const result = await database(db).prepare(`
    UPDATE todo_talk_phone_profiles
    SET enabled = 0,
        pin_hash = '',
        pin_salt = '',
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE user_key = ?
  `).bind(userKey).run();
  console.info("[todo-talk-phone] phone access disabled", {
    userKey,
    changed: Number(result.meta.changes ?? 0),
  });
  return { disabled: true };
}

export async function markTalkPhoneProviderConfigured(
  userKey: string,
  webhookUrl: string,
  db?: D1Database,
) {
  await ensureTodoDatabase();
  await database(db).prepare(`
    UPDATE todo_talk_phone_profiles
    SET webhook_url = ?,
        provider_configured_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE user_key = ? AND enabled = 1
  `).bind(webhookUrl, userKey).run();
}

export async function findTalkPhoneUserByPin(pin: string, db?: D1Database) {
  if (!validTalkPhonePin(pin)) return null;
  await ensureTodoDatabase();
  const result = await database(db).prepare(`
    SELECT user_key, pin_hash, pin_salt, pin_iterations, enabled, webhook_url,
           provider_configured_at, pin_updated_at, last_authenticated_at, updated_at
    FROM todo_talk_phone_profiles
    WHERE enabled = 1
    ORDER BY updated_at DESC
    LIMIT 20
  `).all<PhoneProfileRow>();
  let matchedUserKey: string | null = null;
  for (const row of result.results) {
    if (row.pin_iterations > MAX_SUPPORTED_PIN_ITERATIONS) {
      console.warn("[todo-talk-phone] skipped legacy PIN hash that must be reset", {
        userKey: row.user_key,
        iterations: row.pin_iterations,
        maximum: MAX_SUPPORTED_PIN_ITERATIONS,
      });
      continue;
    }
    const derived = await derivePinHash(pin, base64UrlToBytes(row.pin_salt), row.pin_iterations);
    const stored = base64UrlToBytes(row.pin_hash);
    if (constantTimeEqual(derived, stored) && !matchedUserKey) matchedUserKey = row.user_key;
  }
  return matchedUserKey;
}

export async function hasEnabledTalkPhoneProfile(db?: D1Database) {
  await ensureTodoDatabase();
  const row = await database(db).prepare(`
    SELECT 1 AS configured
    FROM todo_talk_phone_profiles
    WHERE enabled = 1
    LIMIT 1
  `).first<{ configured: number }>();
  return Boolean(row?.configured);
}

export async function beginTalkPhoneCall(
  input: { callSid: string; fromNumber: string; toNumber: string },
  db?: D1Database,
) {
  if (!validTwilioCallSid(input.callSid)) throw new Error("That phone call identifier is invalid.");
  await ensureTodoDatabase();
  const selected = database(db);
  const fromNumberHash = await hashPhoneNumber(input.fromNumber);
  const recent = await selected.prepare(`
    SELECT COUNT(*) AS count
    FROM todo_talk_phone_calls
    WHERE from_number_hash = ?
      AND started_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-15 minutes')
      AND status IN ('rejected', 'blocked')
  `).bind(fromNumberHash).first<{ count: number }>();
  const blocked = Number(recent?.count ?? 0) >= 5;
  await selected.prepare(`
    INSERT INTO todo_talk_phone_calls (
      call_sid, from_number_hash, to_number, status, failure_reason
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(call_sid) DO NOTHING
  `).bind(
    input.callSid,
    fromNumberHash,
    input.toNumber.slice(0, 40),
    blocked ? "blocked" : "pin_pending",
    blocked ? "source-rate-limit" : null,
  ).run();
  console.info("[todo-talk-phone] inbound call registered", {
    callSid: input.callSid,
    blocked,
    recentRejectedCalls: Number(recent?.count ?? 0),
  });
  return { blocked };
}

export async function readTalkPhoneCall(callSid: string, db?: D1Database) {
  if (!validTwilioCallSid(callSid)) return null;
  await ensureTodoDatabase();
  return database(db).prepare(`
    SELECT call_sid, user_key, from_number_hash, to_number, status, attempt_count,
           stream_token_hash, stream_token_expires_at, stream_token_consumed_at,
           transport, provider_call_id, talk_session_id, started_at,
           authenticated_at, connected_at, ended_at,
           failure_reason
    FROM todo_talk_phone_calls
    WHERE call_sid = ?
  `).bind(callSid).first<PhoneCallRow>();
}

export async function recordFailedTalkPhonePin(callSid: string, db?: D1Database) {
  await ensureTodoDatabase();
  const selected = database(db);
  await selected.prepare(`
    UPDATE todo_talk_phone_calls
    SET attempt_count = attempt_count + 1,
        status = CASE WHEN attempt_count + 1 >= ? THEN 'rejected' ELSE 'pin_pending' END,
        failure_reason = CASE WHEN attempt_count + 1 >= ? THEN 'pin-attempt-limit' ELSE 'pin-mismatch' END
    WHERE call_sid = ? AND status = 'pin_pending'
  `).bind(MAX_PIN_ATTEMPTS, MAX_PIN_ATTEMPTS, callSid).run();
  const call = await readTalkPhoneCall(callSid, db);
  const attempts = Number(call?.attempt_count ?? MAX_PIN_ATTEMPTS);
  console.warn("[todo-talk-phone] PIN rejected", {
    callSid,
    attempts,
    remainingAttempts: Math.max(0, MAX_PIN_ATTEMPTS - attempts),
  });
  return { attempts, remainingAttempts: Math.max(0, MAX_PIN_ATTEMPTS - attempts) };
}

export async function authenticateTalkPhoneCall(callSid: string, userKey: string, db?: D1Database) {
  await ensureTodoDatabase();
  const rawToken = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const tokenHash = await sha256(rawToken);
  const expiresAt = new Date(Date.now() + STREAM_TOKEN_TTL_MS).toISOString();
  const selected = database(db);
  const [callResult] = await selected.batch([
    selected.prepare(`
      UPDATE todo_talk_phone_calls
      SET user_key = ?,
          status = 'authenticated',
          stream_token_hash = ?,
          stream_token_expires_at = ?,
          authenticated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
          failure_reason = NULL
      WHERE call_sid = ? AND status = 'pin_pending' AND attempt_count < ?
    `).bind(userKey, tokenHash, expiresAt, callSid, MAX_PIN_ATTEMPTS),
    selected.prepare(`
      UPDATE todo_talk_phone_profiles
      SET last_authenticated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE user_key = ? AND enabled = 1
    `).bind(userKey),
  ]);
  if (!Number(callResult.meta.changes ?? 0)) throw new Error("That call can no longer be authenticated.");
  console.info("[todo-talk-phone] PIN accepted and stream token issued", {
    callSid,
    userKey,
    expiresAt,
  });
  return { rawToken, expiresAt };
}

export async function consumeTalkPhoneStream(
  input: { callSid: string; rawToken: string },
  db?: D1Database,
) {
  if (!validTwilioCallSid(input.callSid) || input.rawToken.length < 32) return null;
  await ensureTodoDatabase();
  const selected = database(db);
  const tokenHash = await sha256(input.rawToken);
  const result = await selected.prepare(`
    UPDATE todo_talk_phone_calls
    SET status = 'connected',
        stream_token_consumed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
        connected_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE call_sid = ?
      AND status = 'authenticated'
      AND stream_token_hash = ?
      AND stream_token_consumed_at IS NULL
      AND stream_token_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')
  `).bind(input.callSid, tokenHash).run();
  const claimed = Boolean(Number(result.meta.changes ?? 0));
  const call = await readTalkPhoneCall(input.callSid, db);
  if (
    !call?.user_key
    || call.stream_token_hash !== tokenHash
    || call.status !== "connected"
    || !call.connected_at
    || Date.now() - new Date(call.connected_at).valueOf() > PHONE_BRIDGE_SESSION_TTL_MS
  ) {
    return null;
  }
  return {
    userKey: call.user_key,
    talkSessionId: call.talk_session_id,
    replayed: !claimed,
  };
}

export async function connectTalkPhoneSip(
  input: { callSid: string; rawToken: string; providerCallId: string },
  db?: D1Database,
) {
  if (
    !validTwilioCallSid(input.callSid)
    || input.rawToken.length < 32
    || !/^rtc_[A-Za-z0-9_-]{8,200}$/.test(input.providerCallId)
  ) return null;
  await ensureTodoDatabase();
  const selected = database(db);
  const tokenHash = await sha256(input.rawToken);
  const previous = await readTalkPhoneCall(input.callSid, db);
  const replayed = previous?.status === "connected"
    && previous.transport === "sip"
    && previous.provider_call_id === input.providerCallId;
  const result = await selected.prepare(`
    UPDATE todo_talk_phone_calls
    SET status = 'connected',
        transport = 'sip',
        provider_call_id = ?,
        stream_token_consumed_at = COALESCE(
          stream_token_consumed_at,
          strftime('%Y-%m-%dT%H:%M:%fZ','now')
        ),
        connected_at = COALESCE(
          connected_at,
          strftime('%Y-%m-%dT%H:%M:%fZ','now')
        )
    WHERE call_sid = ?
      AND status IN ('authenticated', 'connected')
      AND stream_token_hash = ?
      AND (
        stream_token_consumed_at IS NULL
        OR provider_call_id = ?
      )
      AND (
        stream_token_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')
        OR connected_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-70 minutes')
      )
  `).bind(input.providerCallId, input.callSid, tokenHash, input.providerCallId).run();
  const call = await readTalkPhoneCall(input.callSid, db);
  if (
    !Number(result.meta.changes ?? 0)
    || !call?.user_key
    || call.transport !== "sip"
    || call.provider_call_id !== input.providerCallId
  ) {
    return null;
  }
  console.info("[todo-talk-phone] direct SIP call connected", {
    callSid: input.callSid,
    providerCallId: input.providerCallId,
    replayed,
  });
  return {
    userKey: call.user_key,
    talkSessionId: call.talk_session_id,
  };
}

export async function authenticateTalkPhoneBridge(
  input: { callSid: string; rawToken: string },
  db?: D1Database,
) {
  if (!validTwilioCallSid(input.callSid) || input.rawToken.length < 32) return null;
  await ensureTodoDatabase();
  const tokenHash = await sha256(input.rawToken);
  const call = await database(db).prepare(`
    SELECT call_sid, user_key, from_number_hash, to_number, status, attempt_count,
           stream_token_hash, stream_token_expires_at, stream_token_consumed_at,
           transport, provider_call_id, talk_session_id, started_at,
           authenticated_at, connected_at, ended_at,
           failure_reason
    FROM todo_talk_phone_calls
    WHERE call_sid = ?
      AND status = 'connected'
      AND stream_token_hash = ?
      AND stream_token_consumed_at IS NOT NULL
      AND connected_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-70 minutes')
  `).bind(input.callSid, tokenHash).first<PhoneCallRow>();
  if (!call?.user_key || !call.talk_session_id) return null;
  return {
    userKey: call.user_key,
    talkSessionId: call.talk_session_id,
  };
}

export async function attachTalkSessionToPhoneCall(
  callSid: string,
  talkSessionId: string,
  db?: D1Database,
) {
  await ensureTodoDatabase();
  await database(db).prepare(`
    UPDATE todo_talk_phone_calls
    SET talk_session_id = ?
    WHERE call_sid = ? AND status = 'connected'
  `).bind(talkSessionId, callSid).run();
}

export async function endTalkPhoneCall(
  callSid: string,
  status: "completed" | "failed",
  reason: string,
  db?: D1Database,
) {
  if (!validTwilioCallSid(callSid)) return;
  await ensureTodoDatabase();
  await database(db).prepare(`
    UPDATE todo_talk_phone_calls
    SET status = ?,
        ended_at = COALESCE(ended_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        failure_reason = CASE WHEN ? = 'failed' THEN ? ELSE failure_reason END
    WHERE call_sid = ?
  `).bind(status, status, reason.slice(0, 160), callSid).run();
  console.info("[todo-talk-phone] call ended", { callSid, status, reason: reason.slice(0, 160) });
}

export const talkPhoneSecurity = {
  maxPinAttempts: MAX_PIN_ATTEMPTS,
  pinIterations: PIN_ITERATIONS,
  streamTokenTtlMs: STREAM_TOKEN_TTL_MS,
  bridgeSessionTtlMs: PHONE_BRIDGE_SESSION_TTL_MS,
};
