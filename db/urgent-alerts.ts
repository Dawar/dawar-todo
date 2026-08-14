import { env } from "cloudflare:workers";
import { createTwilioOutboundCall, sendTwilioSms, twilioPhoneConfigured } from "../lib/twilio-phone";
import { nextUrgentAttemptAt } from "../lib/urgent-alert-schedule";
import { MAX_PINNED_TASKS } from "../lib/task-pins";
import { readVerifiedProfilePhone } from "./profile-phone";
import { ensureTodoDatabase } from "./todos";

export type UrgentAlertChannel = "sms" | "voice" | "app";
export type UrgentAlertAction = "ack" | "pin" | "snooze" | "done";

export type UrgentAlertSummary = {
  id: string;
  state: string;
  channels: ["sms", "voice"];
  attemptNumber: number;
  nextAttemptAt: string | null;
};

export type UrgentAlertEnvironment = {
  DB: D1Database;
  TODO_PROFILE_PHONE_KEY?: string;
  TODO_PUBLIC_URL?: string;
  VAPID_SUBJECT?: string;
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;
  TWILIO_PHONE_NUMBER?: string;
};

type CampaignRow = {
  id: string;
  todo_id: number;
  user_key: string;
  source_token_id: string | null;
  source_agent_name: string;
  reply_code: string;
  state: string;
  wave_index: number;
  next_attempt_at: string;
  lease_token: string | null;
  lease_expires_at: string | null;
  last_attempt_at: string | null;
  acknowledged_at: string | null;
  acknowledgement_channel: string | null;
  stopped_reason: string | null;
  created_at: string;
  updated_at: string;
};

type CampaignTaskRow = CampaignRow & {
  title: string;
  status: string;
  priority: number;
  project: string | null;
  due_date: string | null;
  snoozed_until: string | null;
  pinned: number;
};

type AttemptRow = {
  id: string;
  escalation_id: string;
  wave_index: number;
  channel: UrgentAlertChannel;
  provider_sid: string | null;
  status: string;
  submitted_at: string | null;
  delivered_at: string | null;
  error_code: string | null;
};

const LEASE_MS = 2 * 60 * 1_000;
const QUEUE_BATCH_SIZE = 10;

function runtime(environment?: UrgentAlertEnvironment) {
  return environment ?? env as unknown as UrgentAlertEnvironment;
}

function publicBaseUrl(environment?: UrgentAlertEnvironment) {
  const current = runtime(environment);
  const configured = current.TODO_PUBLIC_URL?.trim()
    || (current.VAPID_SUBJECT?.trim().startsWith("http") ? current.VAPID_SUBJECT.trim() : "");
  return (configured || "https://work.dawar.ca").replace(/\/$/, "");
}

function mapSummary(row: CampaignRow): UrgentAlertSummary {
  return {
    id: row.id,
    state: row.state,
    channels: ["sms", "voice"],
    attemptNumber: Number(row.wave_index) + 1,
    nextAttemptAt: ["acknowledged", "cancelled"].includes(row.state) ? null : row.next_attempt_at,
  };
}

function randomReplyCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return [...bytes].map((byte) => alphabet[byte % alphabet.length]).join("");
}

function taskStillRequiresAlert(task: Pick<CampaignTaskRow, "status" | "priority" | "pinned" | "snoozed_until">) {
  return task.status === "open" && task.priority === 1 && !task.pinned && !task.snoozed_until;
}

function compactTaskTitle(title: string, maximum: number) {
  const normalized = title.replace(/\s+/g, " ").trim();
  return normalized.length <= maximum ? normalized : `${normalized.slice(0, maximum - 1).trimEnd()}…`;
}

function smsBody(campaign: CampaignTaskRow, baseUrl: string) {
  const details = [campaign.project ? `Project: ${campaign.project}.` : "", campaign.due_date ? `Due: ${campaign.due_date}.` : ""]
    .filter(Boolean)
    .join(" ");
  const taskUrl = `${baseUrl}/?task=${campaign.todo_id}`;
  return `URGENT from ${compactTaskTitle(campaign.source_agent_name, 60)}: ${compactTaskTitle(campaign.title, 240)}. ${details} ${taskUrl} Ref ${campaign.reply_code}. Reply ACK ${campaign.reply_code}, PIN ${campaign.reply_code}, SNOOZE ${campaign.reply_code} 1H, or DONE ${campaign.reply_code}.`;
}

function providerErrorCode(error: unknown) {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (message.includes("timeout")) return "provider-timeout";
  if (message.includes("not configured") || message.includes("incomplete")) return "provider-unconfigured";
  if (message.includes("does not support sms")) return "sms-unsupported";
  const status = message.match(/\((\d{3})\)/)?.[1];
  return status ? `provider-http-${status}` : "provider-request-failed";
}

async function readCampaign(id: string, environment?: UrgentAlertEnvironment) {
  return runtime(environment).DB.prepare(`
    SELECT * FROM todo_urgent_escalations WHERE id = ?
  `).bind(id).first<CampaignRow>();
}

async function readCampaignTask(id: string, environment?: UrgentAlertEnvironment) {
  return runtime(environment).DB.prepare(`
    SELECT escalations.*, todos.title, todos.status, todos.priority, todos.project,
           todos.due_date, todos.snoozed_until, todos.pinned
    FROM todo_urgent_escalations AS escalations
    INNER JOIN todos ON todos.id = escalations.todo_id
    WHERE escalations.id = ?
  `).bind(id).first<CampaignTaskRow>();
}

export async function createUrgentAlertCampaign(
  input: { todoId: number; userKey: string; sourceTokenId: string; sourceAgentName: string },
  environment?: UrgentAlertEnvironment,
) {
  await ensureTodoDatabase();
  const current = runtime(environment);
  const existing = await current.DB.prepare("SELECT * FROM todo_urgent_escalations WHERE todo_id = ?")
    .bind(input.todoId).first<CampaignRow>();
  if (existing) return mapSummary(existing);
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const id = crypto.randomUUID();
    const replyCode = randomReplyCode();
    try {
      await current.DB.prepare(`
        INSERT INTO todo_urgent_escalations (
          id, todo_id, user_key, source_token_id, source_agent_name,
          reply_code, state, wave_index, next_attempt_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      `).bind(
        id,
        input.todoId,
        input.userKey.toLowerCase(),
        input.sourceTokenId,
        input.sourceAgentName.trim().slice(0, 80) || "API agent",
        replyCode,
      ).run();
      const row = await readCampaign(id, environment);
      if (!row) throw new Error("The urgent alert campaign could not be loaded.");
      console.info("[todo-urgent-alert] campaign queued", {
        escalationId: id,
        todoId: input.todoId,
        sourceTokenId: input.sourceTokenId,
        state: row.state,
        attempt,
      });
      return mapSummary(row);
    } catch (error) {
      const replay = await current.DB.prepare("SELECT * FROM todo_urgent_escalations WHERE todo_id = ?")
        .bind(input.todoId).first<CampaignRow>();
      if (replay) return mapSummary(replay);
      if (attempt === 4) throw error;
      console.warn("[todo-urgent-alert] campaign identifier collision; retrying", { todoId: input.todoId, attempt });
    }
  }
  throw new Error("The urgent alert campaign could not be queued.");
}

export async function acknowledgeUrgentAlertForTodo(
  todoId: number,
  channel: UrgentAlertChannel,
  environment?: UrgentAlertEnvironment,
  userKey?: string,
) {
  await ensureTodoDatabase();
  const result = await runtime(environment).DB.prepare(`
    UPDATE todo_urgent_escalations
    SET state = 'acknowledged', acknowledged_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
        acknowledgement_channel = ?, stopped_reason = 'acknowledged',
        lease_token = NULL, lease_expires_at = NULL,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE todo_id = ? AND state IN ('pending','awaiting_ack','blocked_configuration')
      ${userKey ? "AND user_key = ?" : ""}
  `).bind(channel, todoId, ...(userKey ? [userKey.toLowerCase()] : [])).run();
  const acknowledged = Number(result.meta.changes ?? 0) > 0;
  console.info("[todo-urgent-alert] task acknowledgement processed", { todoId, channel, acknowledged });
  return { todoId, acknowledged };
}

export async function stopUrgentAlertForTodo(
  todoId: number,
  reason: string,
  environment?: UrgentAlertEnvironment,
) {
  await ensureTodoDatabase();
  const result = await runtime(environment).DB.prepare(`
    UPDATE todo_urgent_escalations
    SET state = 'cancelled', stopped_reason = ?, lease_token = NULL, lease_expires_at = NULL,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE todo_id = ? AND state IN ('pending','awaiting_ack','blocked_configuration')
  `).bind(reason.slice(0, 80), todoId).run();
  const stopped = Number(result.meta.changes ?? 0) > 0;
  if (stopped) console.info("[todo-urgent-alert] campaign stopped", { todoId, reason });
  return stopped;
}

export async function stopUrgentAlertForTaskState(
  task: { id: number; status: string; priority: number; pinned: boolean; snoozedUntil: string | null },
  environment?: UrgentAlertEnvironment,
) {
  const reason = task.status !== "open"
    ? "completed"
    : task.priority !== 1
      ? "urgency-lowered"
      : task.pinned
        ? "pinned"
        : task.snoozedUntil
          ? "snoozed"
          : null;
  return reason ? stopUrgentAlertForTodo(task.id, reason, environment) : false;
}

async function attemptForChannel(
  campaignId: string,
  waveIndex: number,
  channel: "sms" | "voice",
  environment?: UrgentAlertEnvironment,
) {
  const current = runtime(environment);
  await current.DB.prepare(`
    INSERT OR IGNORE INTO todo_urgent_attempts (id, escalation_id, wave_index, channel)
    VALUES (?, ?, ?, ?)
  `).bind(crypto.randomUUID(), campaignId, waveIndex, channel).run();
  return current.DB.prepare(`
    SELECT id, escalation_id, wave_index, channel, provider_sid, status,
           submitted_at, delivered_at, error_code
    FROM todo_urgent_attempts
    WHERE escalation_id = ? AND wave_index = ? AND channel = ?
  `).bind(campaignId, waveIndex, channel).first<AttemptRow>();
}

async function markAttemptSubmitted(
  attemptId: string,
  providerSid: string,
  status: string,
  environment?: UrgentAlertEnvironment,
) {
  await runtime(environment).DB.prepare(`
    UPDATE todo_urgent_attempts
    SET provider_sid = ?, status = ?, submitted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
        error_code = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id = ?
  `).bind(providerSid, status.slice(0, 40), attemptId).run();
}

async function markAttemptFailed(attemptId: string, error: unknown, environment?: UrgentAlertEnvironment) {
  const errorCode = providerErrorCode(error);
  await runtime(environment).DB.prepare(`
    UPDATE todo_urgent_attempts
    SET status = 'retry', error_code = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id = ? AND provider_sid IS NULL
  `).bind(errorCode, attemptId).run();
  return errorCode;
}

async function activeVoiceAttempt(environment?: UrgentAlertEnvironment) {
  return runtime(environment).DB.prepare(`
    SELECT 1 AS active
    FROM todo_urgent_attempts
    WHERE channel = 'voice'
      AND status IN ('queued','initiated','ringing','in-progress')
      AND updated_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-3 minutes')
    LIMIT 1
  `).first<{ active: number }>();
}

async function dispatchCampaign(
  campaignId: string,
  leaseToken: string,
  attemptedAt: Date,
  environment?: UrgentAlertEnvironment,
) {
  const current = runtime(environment);
  const campaign = await readCampaignTask(campaignId, environment);
  if (!campaign || campaign.lease_token !== leaseToken) return { sent: 0, blocked: 0, failed: 0 };
  if (!taskStillRequiresAlert(campaign)) {
    await stopUrgentAlertForTodo(campaign.todo_id, "task-state-changed", environment);
    return { sent: 0, blocked: 0, failed: 0 };
  }
  const contact = await readVerifiedProfilePhone(campaign.user_key, environment);
  if (!contact?.urgentAlertsEnabled || !twilioPhoneConfigured(environment)) {
    await current.DB.prepare(`
      UPDATE todo_urgent_escalations
      SET state = 'blocked_configuration', lease_token = NULL, lease_expires_at = NULL,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ? AND lease_token = ?
    `).bind(campaignId, leaseToken).run();
    console.warn("[todo-urgent-alert] campaign blocked by profile configuration", {
      escalationId: campaignId,
      profilePhoneVerified: Boolean(contact),
      urgentAlertsEnabled: Boolean(contact?.urgentAlertsEnabled),
      providerReady: twilioPhoneConfigured(environment),
    });
    return { sent: 0, blocked: 1, failed: 0 };
  }

  const baseUrl = publicBaseUrl(environment);
  const [smsAttempt, voiceAttempt] = await Promise.all([
    attemptForChannel(campaignId, campaign.wave_index, "sms", environment),
    attemptForChannel(campaignId, campaign.wave_index, "voice", environment),
  ]);
  if (!smsAttempt || !voiceAttempt) throw new Error("Urgent alert attempts could not be prepared.");
  let failed = 0;
  let submitted = 0;

  if (!smsAttempt.provider_sid) {
    try {
      const sms = await sendTwilioSms({
        to: contact.phoneNumber,
        body: smsBody(campaign, baseUrl),
        statusCallbackUrl: `${baseUrl}/api/talk/phone/urgent/provider/sms/status?attempt=${encodeURIComponent(smsAttempt.id)}`,
      }, environment);
      await markAttemptSubmitted(smsAttempt.id, sms.sid, sms.status, environment);
      submitted += 1;
    } catch (error) {
      failed += 1;
      const errorCode = await markAttemptFailed(smsAttempt.id, error, environment);
      console.error("[todo-urgent-alert] SMS submission failed", {
        escalationId: campaignId,
        attemptId: smsAttempt.id,
        waveIndex: campaign.wave_index,
        errorCode,
      });
    }
  }

  if (!voiceAttempt.provider_sid) {
    const activeVoice = await activeVoiceAttempt(environment);
    if (activeVoice) {
      await current.DB.prepare(`
        UPDATE todo_urgent_escalations
        SET state = 'awaiting_ack', next_attempt_at = ?, lease_token = NULL, lease_expires_at = NULL,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ? AND lease_token = ?
      `).bind(new Date(attemptedAt.valueOf() + 60_000).toISOString(), campaignId, leaseToken).run();
      console.info("[todo-urgent-alert] voice attempt serialized behind active call", {
        escalationId: campaignId,
        attemptId: voiceAttempt.id,
        waveIndex: campaign.wave_index,
      });
      return { sent: submitted, blocked: 0, failed };
    }
    try {
      const voice = await createTwilioOutboundCall({
        to: contact.phoneNumber,
        instructionUrl: `${baseUrl}/api/talk/phone/urgent/provider/voice?attempt=${encodeURIComponent(voiceAttempt.id)}`,
        statusCallbackUrl: `${baseUrl}/api/talk/phone/urgent/provider/voice/status?attempt=${encodeURIComponent(voiceAttempt.id)}`,
      }, environment);
      await markAttemptSubmitted(voiceAttempt.id, voice.sid, voice.status, environment);
      submitted += 1;
    } catch (error) {
      failed += 1;
      const errorCode = await markAttemptFailed(voiceAttempt.id, error, environment);
      console.error("[todo-urgent-alert] voice submission failed", {
        escalationId: campaignId,
        attemptId: voiceAttempt.id,
        waveIndex: campaign.wave_index,
        errorCode,
      });
    }
  }

  if (failed > 0) {
    await current.DB.prepare(`
      UPDATE todo_urgent_escalations
      SET state = 'awaiting_ack', next_attempt_at = ?, lease_token = NULL, lease_expires_at = NULL,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ? AND lease_token = ?
    `).bind(new Date(attemptedAt.valueOf() + 60_000).toISOString(), campaignId, leaseToken).run();
    return { sent: submitted, blocked: 0, failed };
  }

  const settings = await current.DB.prepare("SELECT value FROM app_settings WHERE key = 'snooze_timezone'")
    .first<{ value: string }>();
  const nextAttemptAt = nextUrgentAttemptAt(campaign.wave_index, attemptedAt, {
    timeZone: settings?.value || "America/Toronto",
    callWindowStart: contact.callWindowStart,
    callWindowEnd: contact.callWindowEnd,
  }).toISOString();
  await current.DB.prepare(`
    UPDATE todo_urgent_escalations
    SET state = 'awaiting_ack', wave_index = wave_index + 1,
        next_attempt_at = ?, last_attempt_at = ?, lease_token = NULL, lease_expires_at = NULL,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id = ? AND lease_token = ?
  `).bind(nextAttemptAt, attemptedAt.toISOString(), campaignId, leaseToken).run();
  console.info("[todo-urgent-alert] campaign wave submitted", {
    escalationId: campaignId,
    todoId: campaign.todo_id,
    waveIndex: campaign.wave_index,
    channelsSubmitted: submitted,
    nextAttemptAt,
  });
  return { sent: submitted, blocked: 0, failed: 0 };
}

export async function processUrgentAlertQueue(
  scheduledAt = new Date(),
  environment?: UrgentAlertEnvironment,
  onlyCampaignIds?: string[],
) {
  await ensureTodoDatabase();
  const current = runtime(environment);
  const startedAt = Date.now();
  let resumedConfiguration = 0;
  if (twilioPhoneConfigured(environment)) {
    const resumed = await current.DB.prepare(`
      UPDATE todo_urgent_escalations
      SET state = 'pending', next_attempt_at = MIN(next_attempt_at, ?),
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE state = 'blocked_configuration'
        AND EXISTS (
          SELECT 1 FROM todo_profile_contacts
          WHERE todo_profile_contacts.user_key = todo_urgent_escalations.user_key
            AND todo_profile_contacts.phone_verified_at IS NOT NULL
            AND todo_profile_contacts.urgent_alerts_enabled = 1
        )
    `).bind(scheduledAt.toISOString()).run();
    resumedConfiguration = Number(resumed.meta.changes ?? 0);
  }
  await current.DB.prepare(`
    UPDATE todo_urgent_escalations
    SET state = 'cancelled', stopped_reason = 'task-state-changed',
        lease_token = NULL, lease_expires_at = NULL,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE state IN ('pending','awaiting_ack','blocked_configuration')
      AND NOT EXISTS (
        SELECT 1 FROM todos
        WHERE todos.id = todo_urgent_escalations.todo_id
          AND todos.status = 'open' AND todos.priority = 1
          AND todos.pinned = 0 AND todos.snoozed_until IS NULL
      )
  `).run();
  const ids = onlyCampaignIds?.filter((id) => /^[0-9a-f-]{36}$/i.test(id)) ?? [];
  const candidates = await current.DB.prepare(`
    SELECT * FROM todo_urgent_escalations
    WHERE state IN ('pending','awaiting_ack')
      AND next_attempt_at <= ?
      AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
      ${ids.length ? `AND id IN (${ids.map(() => "?").join(",")})` : ""}
    ORDER BY next_attempt_at ASC, created_at ASC
    LIMIT ${QUEUE_BATCH_SIZE}
  `).bind(scheduledAt.toISOString(), scheduledAt.toISOString(), ...ids).all<CampaignRow>();
  const totals = { due: candidates.results.length, sent: 0, blocked: 0, failed: 0 };
  for (const candidate of candidates.results) {
    const leaseToken = crypto.randomUUID();
    const leaseExpiresAt = new Date(scheduledAt.valueOf() + LEASE_MS).toISOString();
    const claim = await current.DB.prepare(`
      UPDATE todo_urgent_escalations
      SET lease_token = ?, lease_expires_at = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ? AND state IN ('pending','awaiting_ack') AND next_attempt_at <= ?
        AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
    `).bind(leaseToken, leaseExpiresAt, candidate.id, scheduledAt.toISOString(), scheduledAt.toISOString()).run();
    if (!Number(claim.meta.changes ?? 0)) continue;
    try {
      const result = await dispatchCampaign(candidate.id, leaseToken, scheduledAt, environment);
      totals.sent += result.sent;
      totals.blocked += result.blocked;
      totals.failed += result.failed;
    } catch (error) {
      totals.failed += 1;
      await current.DB.prepare(`
        UPDATE todo_urgent_escalations
        SET next_attempt_at = ?, lease_token = NULL, lease_expires_at = NULL,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ? AND lease_token = ?
      `).bind(new Date(scheduledAt.valueOf() + 60_000).toISOString(), candidate.id, leaseToken).run();
      console.error("[todo-urgent-alert] leased campaign dispatch failed", {
        escalationId: candidate.id,
        leaseToken,
        errorCode: providerErrorCode(error),
      });
    }
  }
  console.info("[todo-urgent-alert] queue processed", {
    scheduledAt: scheduledAt.toISOString(),
    ...totals,
    resumedConfiguration,
    durationMs: Date.now() - startedAt,
  });
  return totals;
}

export async function readUrgentAlertAttemptContext(attemptId: string, environment?: UrgentAlertEnvironment) {
  await ensureTodoDatabase();
  if (!/^[0-9a-f-]{36}$/i.test(attemptId)) return null;
  return runtime(environment).DB.prepare(`
    SELECT attempts.id AS attempt_id, attempts.channel, attempts.provider_sid,
           escalations.id AS escalation_id, escalations.todo_id, escalations.user_key,
           escalations.source_agent_name, escalations.reply_code, escalations.state,
           todos.title, todos.status, todos.priority, todos.pinned, todos.snoozed_until
    FROM todo_urgent_attempts AS attempts
    INNER JOIN todo_urgent_escalations AS escalations ON escalations.id = attempts.escalation_id
    INNER JOIN todos ON todos.id = escalations.todo_id
    WHERE attempts.id = ?
  `).bind(attemptId).first<{
    attempt_id: string;
    channel: string;
    provider_sid: string | null;
    escalation_id: string;
    todo_id: number;
    user_key: string;
    source_agent_name: string;
    reply_code: string;
    state: string;
    title: string;
    status: string;
    priority: number;
    pinned: number;
    snoozed_until: string | null;
  }>();
}

export async function recordUrgentAttemptStatus(
  input: { attemptId: string; channel: "sms" | "voice"; providerSid: string; status: string; providerErrorCode?: string | null },
  environment?: UrgentAlertEnvironment,
) {
  await ensureTodoDatabase();
  const normalized = input.status.trim().toLowerCase().slice(0, 40) || "unknown";
  const errorCode = input.providerErrorCode && /^\d{3,8}$/.test(input.providerErrorCode)
    ? `twilio-${input.providerErrorCode}`
    : null;
  const delivered = input.channel === "sms" && ["delivered", "read"].includes(normalized);
  const result = await runtime(environment).DB.prepare(`
    UPDATE todo_urgent_attempts
    SET provider_sid = COALESCE(provider_sid, ?), status = ?,
        delivered_at = CASE WHEN ? THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE delivered_at END,
        error_code = COALESCE(?, error_code),
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id = ? AND channel = ? AND (provider_sid IS NULL OR provider_sid = ?)
  `).bind(input.providerSid, normalized, delivered ? 1 : 0, errorCode, input.attemptId, input.channel, input.providerSid).run();
  console.info("[todo-urgent-alert] provider status recorded", {
    attemptId: input.attemptId,
    channel: input.channel,
    status: normalized,
    errorCode,
    matched: Number(result.meta.changes ?? 0) > 0,
  });
  return Number(result.meta.changes ?? 0) > 0;
}

export async function applyUrgentAlertAction(
  input: { escalationId: string; action: UrgentAlertAction; channel: UrgentAlertChannel },
  environment?: UrgentAlertEnvironment,
) {
  await ensureTodoDatabase();
  const current = runtime(environment);
  const campaign = await readCampaignTask(input.escalationId, environment);
  if (!campaign || !["pending", "awaiting_ack", "blocked_configuration"].includes(campaign.state)) {
    return { applied: false, action: input.action };
  }
  if (input.action === "ack") {
    const result = await acknowledgeUrgentAlertForTodo(campaign.todo_id, input.channel, environment);
    return { applied: result.acknowledged, action: input.action, todoId: campaign.todo_id };
  }
  const stopReason = input.action === "pin" ? "pinned" : input.action === "snooze" ? "snoozed" : "completed";
  const taskStatement = input.action === "pin"
    ? current.DB.prepare(`
      UPDATE todos
      SET pinned = 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ? AND status = 'open'
        AND (pinned = 1 OR (SELECT COUNT(*) FROM todos WHERE pinned = 1) < ?)
    `).bind(campaign.todo_id, MAX_PINNED_TASKS)
    : input.action === "snooze"
      ? current.DB.prepare("UPDATE todos SET snoozed_until = ?, pinned = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND status = 'open'")
        .bind(new Date(Date.now() + 60 * 60 * 1_000).toISOString(), campaign.todo_id)
      : current.DB.prepare("UPDATE todos SET status = 'completed', completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), snoozed_until = NULL, pinned = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
        .bind(campaign.todo_id);
  const taskResult = await taskStatement.run();
  const applied = Number(taskResult.meta.changes ?? 0) > 0;
  if (applied) {
    await current.DB.prepare(`
      UPDATE todo_urgent_escalations
      SET state = 'cancelled', stopped_reason = ?, acknowledgement_channel = ?,
          acknowledged_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
          lease_token = NULL, lease_expires_at = NULL,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ? AND state IN ('pending','awaiting_ack','blocked_configuration')
    `).bind(stopReason, input.channel, campaign.id).run();
  }
  console.info("[todo-urgent-alert] task action applied", {
    escalationId: campaign.id,
    todoId: campaign.todo_id,
    action: input.action,
    channel: input.channel,
    applied,
  });
  return {
    applied,
    action: input.action,
    todoId: campaign.todo_id,
    ...(!applied && input.action === "pin" ? { reason: "pin-limit" as const } : {}),
  };
}

export async function applyUrgentAlertReply(
  input: { userKey: string; code: string | null; action: UrgentAlertAction },
  environment?: UrgentAlertEnvironment,
) {
  await ensureTodoDatabase();
  const current = runtime(environment);
  const normalizedCode = input.code?.trim().toUpperCase() || null;
  const row = normalizedCode
    ? await current.DB.prepare(`
      SELECT * FROM todo_urgent_escalations
      WHERE user_key = ? AND reply_code = ?
        AND state IN ('pending','awaiting_ack','blocked_configuration')
    `).bind(input.userKey, normalizedCode).first<CampaignRow>()
    : await current.DB.prepare(`
      SELECT * FROM todo_urgent_escalations
      WHERE user_key = ? AND state IN ('pending','awaiting_ack','blocked_configuration')
      ORDER BY last_attempt_at DESC, created_at DESC
      LIMIT 2
    `).bind(input.userKey).all<CampaignRow>().then((result) => result.results.length === 1 ? result.results[0] : null);
  if (!row) return { applied: false, reason: normalizedCode ? "not-found" : "code-required" };
  return applyUrgentAlertAction({ escalationId: row.id, action: input.action, channel: "sms" }, environment);
}

export async function urgentAlertDiagnostics(userKey: string, environment?: UrgentAlertEnvironment) {
  await ensureTodoDatabase();
  const current = runtime(environment);
  const [states, recent] = await Promise.all([
    current.DB.prepare(`
      SELECT state, COUNT(*) AS count, MIN(next_attempt_at) AS oldest_next_attempt_at
      FROM todo_urgent_escalations
      WHERE user_key = ?
      GROUP BY state
    `).bind(userKey).all<{ state: string; count: number; oldest_next_attempt_at: string | null }>(),
    current.DB.prepare(`
      SELECT channel, status, error_code, updated_at
      FROM todo_urgent_attempts
      WHERE escalation_id IN (SELECT id FROM todo_urgent_escalations WHERE user_key = ?)
      ORDER BY updated_at DESC LIMIT 12
    `).bind(userKey).all<{ channel: string; status: string; error_code: string | null; updated_at: string }>(),
  ]);
  return {
    privacy: "Phone numbers, task text, task IDs, campaign IDs, provider IDs, and API token details are omitted.",
    states: states.results.map((row) => ({
      state: row.state,
      count: Number(row.count),
      oldestNextAttemptAt: row.oldest_next_attempt_at,
    })),
    recentAttempts: recent.results.map((row) => ({
      channel: row.channel,
      status: row.status,
      errorCode: row.error_code,
      updatedAt: row.updated_at,
    })),
  };
}
