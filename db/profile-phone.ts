import { env } from "cloudflare:workers";
import { sendTwilioSms, twilioPhoneConfigured } from "../lib/twilio-phone";
import { ensureTodoDatabase } from "./todos";

type ProfilePhoneEnvironment = {
  DB: D1Database;
  TODO_PROFILE_PHONE_KEY?: string;
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;
  TWILIO_PHONE_NUMBER?: string;
};

type ContactRow = {
  user_key: string;
  phone_ciphertext: string | null;
  phone_iv: string | null;
  phone_hash: string | null;
  phone_suffix: string | null;
  phone_verified_at: string | null;
  urgent_alerts_enabled: number;
  call_window_start: number;
  call_window_end: number;
  updated_at: string;
};

type VerificationRow = {
  id: string;
  user_key: string;
  phone_ciphertext: string;
  phone_iv: string;
  phone_hash: string;
  phone_suffix: string;
  code_hash: string;
  attempt_count: number;
  expires_at: string;
  consumed_at: string | null;
};

const VERIFICATION_TTL_MS = 10 * 60 * 1_000;
const MAX_VERIFICATION_ATTEMPTS = 5;
const MAX_VERIFICATIONS_PER_15_MINUTES = 5;

function runtime(environment?: ProfilePhoneEnvironment) {
  return environment ?? env as unknown as ProfilePhoneEnvironment;
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

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return bytesToBase64Url(new Uint8Array(digest));
}

async function encryptionKey(environment?: ProfilePhoneEnvironment) {
  const secret = runtime(environment).TODO_PROFILE_PHONE_KEY?.trim() ?? "";
  if (secret.length < 32) throw new Error("Profile phone encryption is not configured.");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function encryptPhone(phoneNumber: string, environment?: ProfilePhoneEnvironment) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    await encryptionKey(environment),
    new TextEncoder().encode(phoneNumber),
  );
  return {
    ciphertext: bytesToBase64Url(new Uint8Array(ciphertext)),
    iv: bytesToBase64Url(iv),
  };
}

async function decryptPhone(ciphertext: string, iv: string, environment?: ProfilePhoneEnvironment) {
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64UrlToBytes(iv) as BufferSource },
    await encryptionKey(environment),
    base64UrlToBytes(ciphertext) as BufferSource,
  );
  return new TextDecoder().decode(plaintext);
}

export function normalizeProfilePhone(value: string) {
  const trimmed = value.trim();
  const digits = trimmed.replace(/\D/g, "");
  const normalized = digits.length === 10
    ? `+1${digits}`
    : trimmed.startsWith("+")
      ? `+${digits}`
      : digits.length >= 11 && digits.length <= 15
        ? `+${digits}`
        : "";
  if (!/^\+[1-9]\d{7,14}$/.test(normalized)) {
    throw new Error("Enter a valid phone number including its country code.");
  }
  return normalized;
}

function publicProfile(row: ContactRow | null, environment?: ProfilePhoneEnvironment) {
  const configured = Boolean(row?.phone_verified_at && row.phone_ciphertext && row.phone_iv);
  return {
    configured,
    maskedPhoneNumber: configured ? `••• ••• ${row!.phone_suffix}` : null,
    phoneVerifiedAt: row?.phone_verified_at ?? null,
    urgentAlertsEnabled: configured && Boolean(row?.urgent_alerts_enabled),
    callWindowStart: Number(row?.call_window_start ?? 8),
    callWindowEnd: Number(row?.call_window_end ?? 22),
    providerReady: twilioPhoneConfigured(environment),
    voiceReady: twilioPhoneConfigured(environment),
    smsReady: twilioPhoneConfigured(environment),
    updatedAt: row?.updated_at ?? null,
  };
}

async function readContact(userKey: string, environment?: ProfilePhoneEnvironment) {
  const current = runtime(environment);
  return current.DB.prepare(`
    SELECT user_key, phone_ciphertext, phone_iv, phone_hash, phone_suffix,
           phone_verified_at, urgent_alerts_enabled, call_window_start,
           call_window_end, updated_at
    FROM todo_profile_contacts
    WHERE user_key = ?
  `).bind(userKey).first<ContactRow>();
}

export async function readProfilePhone(userKey: string, environment?: ProfilePhoneEnvironment) {
  await ensureTodoDatabase();
  return publicProfile(await readContact(userKey, environment), environment);
}

export async function readVerifiedProfilePhone(userKey: string, environment?: ProfilePhoneEnvironment) {
  await ensureTodoDatabase();
  const row = await readContact(userKey, environment);
  if (!row?.phone_verified_at || !row.phone_ciphertext || !row.phone_iv) return null;
  return {
    phoneNumber: await decryptPhone(row.phone_ciphertext, row.phone_iv, environment),
    phoneHash: row.phone_hash,
    phoneSuffix: row.phone_suffix,
    phoneVerifiedAt: row.phone_verified_at,
    urgentAlertsEnabled: Boolean(row.urgent_alerts_enabled),
    callWindowStart: Number(row.call_window_start),
    callWindowEnd: Number(row.call_window_end),
  };
}

export async function profileUserKeyForPhone(rawPhoneNumber: string, environment?: ProfilePhoneEnvironment) {
  await ensureTodoDatabase();
  const phoneNumber = normalizeProfilePhone(rawPhoneNumber);
  const phoneHash = await sha256(phoneNumber);
  const row = await runtime(environment).DB.prepare(`
    SELECT user_key
    FROM todo_profile_contacts
    WHERE phone_hash = ? AND phone_verified_at IS NOT NULL
    ORDER BY updated_at DESC
    LIMIT 1
  `).bind(phoneHash).first<{ user_key: string }>();
  return row?.user_key ?? null;
}

export async function disableUrgentAlertsForUser(
  userKey: string,
  reason: "sms-stop" | "owner-disabled",
  environment?: ProfilePhoneEnvironment,
) {
  await ensureTodoDatabase();
  const current = runtime(environment);
  await current.DB.batch([
    current.DB.prepare(`
      UPDATE todo_profile_contacts
      SET urgent_alerts_enabled = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE user_key = ?
    `).bind(userKey),
    current.DB.prepare(`
      UPDATE todo_urgent_escalations
      SET state = 'cancelled', stopped_reason = ?, lease_token = NULL, lease_expires_at = NULL,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE user_key = ? AND state IN ('pending','awaiting_ack','blocked_configuration')
    `).bind(reason, userKey),
  ]);
  console.info("[todo-profile-phone] urgent alerts disabled", { userKey, reason });
  return readProfilePhone(userKey, environment);
}

export async function beginProfilePhoneVerification(
  userKey: string,
  rawPhoneNumber: string,
  environment?: ProfilePhoneEnvironment,
) {
  await ensureTodoDatabase();
  const current = runtime(environment);
  if (!twilioPhoneConfigured(environment)) throw new Error("Twilio phone delivery is not configured.");
  const recent = await current.DB.prepare(`
    SELECT COUNT(*) AS count
    FROM todo_profile_phone_verifications
    WHERE user_key = ?
      AND created_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-15 minutes')
  `).bind(userKey).first<{ count: number }>();
  if (Number(recent?.count ?? 0) >= MAX_VERIFICATIONS_PER_15_MINUTES) {
    throw new Error("Too many verification codes were requested. Try again in 15 minutes.");
  }
  const phoneNumber = normalizeProfilePhone(rawPhoneNumber);
  const id = crypto.randomUUID();
  const code = String(100_000 + crypto.getRandomValues(new Uint32Array(1))[0] % 900_000);
  const [{ ciphertext, iv }, phoneHash, codeHash] = await Promise.all([
    encryptPhone(phoneNumber, environment),
    sha256(phoneNumber),
    sha256(`${id}:${code}`),
  ]);
  const expiresAt = new Date(Date.now() + VERIFICATION_TTL_MS).toISOString();
  const suffix = phoneNumber.replace(/\D/g, "").slice(-4);
  await current.DB.batch([
    current.DB.prepare(`
      DELETE FROM todo_profile_phone_verifications
      WHERE user_key = ? AND consumed_at IS NULL
    `).bind(userKey),
    current.DB.prepare(`
      INSERT INTO todo_profile_phone_verifications (
        id, user_key, phone_ciphertext, phone_iv, phone_hash, phone_suffix,
        code_hash, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(id, userKey, ciphertext, iv, phoneHash, suffix, codeHash, expiresAt),
  ]);
  try {
    await sendTwilioSms({
      to: phoneNumber,
      body: `Dawar Todo verification code: ${code}. It expires in 10 minutes.`,
    }, environment);
  } catch (error) {
    await current.DB.prepare("DELETE FROM todo_profile_phone_verifications WHERE id = ?").bind(id).run();
    throw error;
  }
  console.info("[todo-profile-phone] verification sent", {
    userKey,
    challengeId: id,
    phoneSuffix: suffix,
    expiresAt,
  });
  return { challengeId: id, maskedPhoneNumber: `••• ••• ${suffix}`, expiresAt };
}

export async function confirmProfilePhoneVerification(
  userKey: string,
  challengeId: string,
  code: string,
  environment?: ProfilePhoneEnvironment,
) {
  await ensureTodoDatabase();
  const current = runtime(environment);
  if (!/^[0-9a-f-]{36}$/i.test(challengeId) || !/^\d{6}$/.test(code)) {
    throw new Error("Enter the 6 digit verification code.");
  }
  const row = await current.DB.prepare(`
    SELECT id, user_key, phone_ciphertext, phone_iv, phone_hash, phone_suffix,
           code_hash, attempt_count, expires_at, consumed_at
    FROM todo_profile_phone_verifications
    WHERE id = ? AND user_key = ?
  `).bind(challengeId, userKey).first<VerificationRow>();
  if (!row || row.consumed_at || row.expires_at <= new Date().toISOString()) {
    throw new Error("That verification code expired. Request a new one.");
  }
  if (row.attempt_count >= MAX_VERIFICATION_ATTEMPTS) {
    throw new Error("Too many incorrect codes. Request a new one.");
  }
  const candidateHash = await sha256(`${challengeId}:${code}`);
  if (candidateHash !== row.code_hash) {
    await current.DB.prepare(`
      UPDATE todo_profile_phone_verifications
      SET attempt_count = attempt_count + 1
      WHERE id = ? AND consumed_at IS NULL
    `).bind(challengeId).run();
    console.warn("[todo-profile-phone] verification code rejected", {
      userKey,
      challengeId,
      attempts: row.attempt_count + 1,
    });
    throw new Error("That verification code is incorrect.");
  }
  await current.DB.batch([
    current.DB.prepare(`
      INSERT INTO todo_profile_contacts (
        user_key, phone_ciphertext, phone_iv, phone_hash, phone_suffix,
        phone_verified_at, urgent_alerts_enabled, updated_at
      ) VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ON CONFLICT(user_key) DO UPDATE SET
        phone_ciphertext = excluded.phone_ciphertext,
        phone_iv = excluded.phone_iv,
        phone_hash = excluded.phone_hash,
        phone_suffix = excluded.phone_suffix,
        phone_verified_at = excluded.phone_verified_at,
        urgent_alerts_enabled = 1,
        updated_at = excluded.updated_at
    `).bind(userKey, row.phone_ciphertext, row.phone_iv, row.phone_hash, row.phone_suffix),
    current.DB.prepare(`
      UPDATE todo_profile_phone_verifications
      SET consumed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ? AND consumed_at IS NULL
    `).bind(challengeId),
    current.DB.prepare(`
      UPDATE todo_urgent_escalations
      SET state = 'pending',
          next_attempt_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE user_key = ? AND state = 'blocked_configuration'
        AND EXISTS (
          SELECT 1 FROM todos
          WHERE todos.id = todo_urgent_escalations.todo_id
            AND todos.status = 'open' AND todos.priority = 1
            AND todos.pinned = 0 AND todos.snoozed_until IS NULL
        )
    `).bind(userKey),
  ]);
  console.info("[todo-profile-phone] profile number verified", {
    userKey,
    challengeId,
    phoneSuffix: row.phone_suffix,
    urgentAlertsEnabled: true,
  });
  return readProfilePhone(userKey, environment);
}

export async function updateProfilePhonePreferences(
  userKey: string,
  input: { urgentAlertsEnabled: boolean; callWindowStart: number; callWindowEnd: number },
  environment?: ProfilePhoneEnvironment,
) {
  await ensureTodoDatabase();
  const current = runtime(environment);
  const start = Number(input.callWindowStart);
  const end = Number(input.callWindowEnd);
  if (!Number.isInteger(start) || start < 0 || start > 23 || !Number.isInteger(end) || end < 1 || end > 24 || start >= end) {
    throw new Error("Choose a valid call window.");
  }
  const contact = await readContact(userKey, environment);
  if (!contact?.phone_verified_at) throw new Error("Verify a profile phone number first.");
  await current.DB.batch([
    current.DB.prepare(`
      UPDATE todo_profile_contacts
      SET urgent_alerts_enabled = ?, call_window_start = ?, call_window_end = ?,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE user_key = ? AND phone_verified_at IS NOT NULL
    `).bind(input.urgentAlertsEnabled ? 1 : 0, start, end, userKey),
    ...(!input.urgentAlertsEnabled ? [current.DB.prepare(`
      UPDATE todo_urgent_escalations
      SET state = 'cancelled', stopped_reason = 'alerts-disabled',
          lease_token = NULL, lease_expires_at = NULL,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE user_key = ? AND state IN ('pending','awaiting_ack','blocked_configuration')
    `).bind(userKey)] : []),
  ]);
  console.info("[todo-profile-phone] preferences updated", {
    userKey,
    urgentAlertsEnabled: input.urgentAlertsEnabled,
    callWindowStart: start,
    callWindowEnd: end,
  });
  return readProfilePhone(userKey, environment);
}

export async function clearProfilePhone(userKey: string, environment?: ProfilePhoneEnvironment) {
  await ensureTodoDatabase();
  const current = runtime(environment);
  await current.DB.batch([
    current.DB.prepare(`
      UPDATE todo_profile_contacts
      SET phone_ciphertext = NULL, phone_iv = NULL, phone_hash = NULL,
          phone_suffix = NULL, phone_verified_at = NULL,
          urgent_alerts_enabled = 0,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE user_key = ?
    `).bind(userKey),
    current.DB.prepare(`
      UPDATE todo_urgent_escalations
      SET state = 'cancelled', stopped_reason = 'profile-phone-removed',
          lease_token = NULL, lease_expires_at = NULL,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE user_key = ? AND state IN ('pending','awaiting_ack','blocked_configuration')
    `).bind(userKey),
  ]);
  console.info("[todo-profile-phone] profile number removed", { userKey });
  return readProfilePhone(userKey, environment);
}

export const profilePhoneLimits = {
  verificationTtlMs: VERIFICATION_TTL_MS,
  maxVerificationAttempts: MAX_VERIFICATION_ATTEMPTS,
};
