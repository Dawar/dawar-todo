import { sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const todos = sqliteTable(
  "todos",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    title: text("title").notNull(),
    notes: text("notes").notNull().default(""),
    status: text("status").notNull().default("open"),
    priority: integer("priority").notNull().default(3),
    dueDate: text("due_date"),
    project: text("project"),
    context: text("context"),
    sourceKind: text("source_kind"),
    sourceId: integer("source_id"),
    clientId: text("client_id"),
    completedAt: text("completed_at"),
    snoozedUntil: text("snoozed_until"),
    recurrenceCron: text("recurrence_cron"),
    recurrenceLastFiredAt: text("recurrence_last_fired_at"),
    pinned: integer("pinned", { mode: "boolean" }).notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (table) => [
    index("todos_status_idx").on(table.status),
    index("todos_project_idx").on(table.project),
    index("todos_due_date_idx").on(table.dueDate),
    index("todos_snoozed_until_idx").on(table.snoozedUntil),
    index("todos_recurrence_cron_idx").on(table.recurrenceCron),
    index("todos_pinned_idx").on(table.pinned),
    index("todos_sort_order_idx").on(table.sortOrder),
    uniqueIndex("todos_source_idx").on(table.sourceKind, table.sourceId),
    uniqueIndex("todos_client_id_idx").on(table.clientId),
  ],
);

export const appSettings = sqliteTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
});

export const todoFieldVersions = sqliteTable(
  "todo_field_versions",
  {
    todoId: integer("todo_id").notNull(),
    field: text("field").notNull(),
    version: text("version").notNull(),
    mutationId: text("mutation_id").notNull(),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (table) => [
    primaryKey({ columns: [table.todoId, table.field] }),
    index("todo_field_versions_mutation_idx").on(table.mutationId),
  ],
);

export const todoProjects = sqliteTable("todo_projects", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
});

export const todoActionHistory = sqliteTable(
  "todo_action_history",
  {
    id: text("id").primaryKey(),
    snapshot: text("snapshot").notNull(),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (table) => [index("todo_action_history_created_at_idx").on(table.createdAt)],
);

export const todoCalendarFeeds = sqliteTable(
  "todo_calendar_feeds",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    token: text("token").notNull(),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    revokedAt: text("revoked_at"),
  },
  (table) => [
    uniqueIndex("todo_calendar_feeds_token_idx").on(table.token),
    index("todo_calendar_feeds_revoked_at_idx").on(table.revokedAt),
  ],
);

export const todoApiTokens = sqliteTable(
  "todo_api_tokens",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    tokenPrefix: text("token_prefix").notNull(),
    tokenHash: text("token_hash").notNull(),
    encryptedToken: text("encrypted_token"),
    createdByEmail: text("created_by_email"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    lastUsedAt: text("last_used_at"),
    expiresAt: text("expires_at"),
    revokedAt: text("revoked_at"),
  },
  (table) => [
    uniqueIndex("todo_api_tokens_hash_idx").on(table.tokenHash),
    index("todo_api_tokens_revoked_at_idx").on(table.revokedAt),
    index("todo_api_tokens_expires_at_idx").on(table.expiresAt),
  ],
);

export const todoAttachments = sqliteTable(
  "todo_attachments",
  {
    id: text("id").primaryKey(),
    todoId: integer("todo_id"),
    draftToken: text("draft_token"),
    originalKey: text("original_key").notNull().unique(),
    displayKey: text("display_key").notNull().unique(),
    thumbnailKey: text("thumbnail_key").notNull().unique(),
    fileName: text("file_name").notNull(),
    mimeType: text("mime_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    kind: text("kind").notNull().default("image"),
    durationMs: integer("duration_ms").notNull().default(0),
    uploadState: text("upload_state").notNull().default("ready"),
    sortOrder: integer("sort_order").notNull().default(0),
    expiresAt: text("expires_at"),
    deletedAt: text("deleted_at"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (table) => [
    index("todo_attachments_todo_id_idx").on(table.todoId),
    index("todo_attachments_draft_token_idx").on(table.draftToken),
    index("todo_attachments_expires_at_idx").on(table.expiresAt),
    index("todo_attachments_deleted_at_idx").on(table.deletedAt),
  ],
);

export const todoPushSubscriptions = sqliteTable(
  "todo_push_subscriptions",
  {
    id: text("id").primaryKey(),
    endpoint: text("endpoint").notNull(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    deviceId: text("device_id").notNull(),
    failureCount: integer("failure_count").notNull().default(0),
    lastSuccessAt: text("last_success_at"),
    lastFailureStatus: integer("last_failure_status"),
    lastFailureAt: text("last_failure_at"),
    disabledAt: text("disabled_at"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (table) => [
    uniqueIndex("todo_push_subscriptions_endpoint_idx").on(table.endpoint),
    index("todo_push_subscriptions_device_idx").on(table.deviceId),
    index("todo_push_subscriptions_disabled_idx").on(table.disabledAt),
  ],
);

export const todoPushEvents = sqliteTable(
  "todo_push_events",
  {
    id: text("id").primaryKey(),
    eventType: text("event_type").notNull(),
    todoId: integer("todo_id").notNull(),
    todoTitle: text("todo_title").notNull(),
    originDeviceId: text("origin_device_id"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    deliverAfter: text("deliver_after").notNull(),
    deliveredAt: text("delivered_at"),
  },
  (table) => [
    index("todo_push_events_delivery_idx").on(table.deliveredAt, table.deliverAfter),
    index("todo_push_events_todo_idx").on(table.todoId),
  ],
);

export const todoPushDeliveries = sqliteTable(
  "todo_push_deliveries",
  {
    eventId: text("event_id").notNull(),
    subscriptionId: text("subscription_id").notNull(),
    deliveredAt: text("delivered_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (table) => [
    primaryKey({ columns: [table.eventId, table.subscriptionId] }),
    index("todo_push_deliveries_subscription_idx").on(table.subscriptionId),
  ],
);

export const todoSyncChanges = sqliteTable(
  "todo_sync_changes",
  {
    revision: integer("revision").primaryKey({ autoIncrement: true }),
    entityType: text("entity_type").notNull(),
    entityKey: text("entity_key").notNull(),
    operation: text("operation").notNull(),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (table) => [
    index("todo_sync_changes_created_at_idx").on(table.createdAt),
    index("todo_sync_changes_entity_idx").on(table.entityType, table.entityKey, table.revision),
  ],
);

export const todoMutationReceipts = sqliteTable(
  "todo_mutation_receipts",
  {
    operationId: text("operation_id").primaryKey(),
    kind: text("kind").notNull(),
    responseJson: text("response_json").notNull(),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (table) => [
    index("todo_mutation_receipts_created_at_idx").on(table.createdAt),
  ],
);

export const todoAssistantWorkspaces = sqliteTable("todo_assistant_workspaces", {
  userKey: text("user_key").primaryKey(),
  selectedTodoId: integer("selected_todo_id"),
  navigatorView: text("navigator_view").notNull().default("open"),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
});

export const todoAssistantThreads = sqliteTable(
  "todo_assistant_threads",
  {
    userKey: text("user_key").notNull(),
    todoId: integer("todo_id").notNull(),
    paused: integer("paused", { mode: "boolean" }).notNull().default(false),
    draftText: text("draft_text").notNull().default(""),
    draftAttachmentIdsJson: text("draft_attachment_ids_json").notNull().default("[]"),
    currentQuestionJson: text("current_question_json"),
    skippedQuestionKeysJson: text("skipped_question_keys_json").notNull().default("[]"),
    understandingJson: text("understanding_json"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (table) => [
    primaryKey({ columns: [table.userKey, table.todoId] }),
    index("todo_assistant_threads_todo_idx").on(table.todoId),
    index("todo_assistant_threads_updated_idx").on(table.updatedAt),
  ],
);

export const todoAssistantMessages = sqliteTable(
  "todo_assistant_messages",
  {
    id: text("id").primaryKey(),
    userKey: text("user_key").notNull(),
    todoId: integer("todo_id").notNull(),
    role: text("role").notNull(),
    kind: text("kind").notNull().default("message"),
    content: text("content").notNull(),
    questionJson: text("question_json"),
    proposalJson: text("proposal_json"),
    sourcesJson: text("sources_json"),
    attachmentIdsJson: text("attachment_ids_json").notNull().default("[]"),
    clientId: text("client_id"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (table) => [
    index("todo_assistant_messages_thread_idx").on(table.userKey, table.todoId, table.createdAt),
    uniqueIndex("todo_assistant_messages_client_idx").on(table.userKey, table.clientId),
  ],
);

export const todoTalkWorkspaces = sqliteTable("todo_talk_workspaces", {
  userKey: text("user_key").primaryKey(),
  activeSessionId: text("active_session_id"),
  lastFocusedTodoId: integer("last_focused_todo_id"),
  summary: text("summary").notNull().default(""),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
});

export const todoTalkThreads = sqliteTable(
  "todo_talk_threads",
  {
    id: text("id").primaryKey(),
    userKey: text("user_key").notNull(),
    kind: text("kind").notNull().default("custom"),
    systemKey: text("system_key"),
    title: text("title").notNull(),
    focusedTodoId: integer("focused_todo_id"),
    summary: text("summary").notNull().default(""),
    draftText: text("draft_text").notNull().default(""),
    deleteToken: text("delete_token"),
    deletedAt: text("deleted_at"),
    purgeAfter: text("purge_after"),
    lastMessageAt: text("last_message_at"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (table) => [
    uniqueIndex("todo_talk_threads_system_idx").on(table.userKey, table.systemKey),
    index("todo_talk_threads_user_idx").on(table.userKey, table.deletedAt, table.lastMessageAt),
    index("todo_talk_threads_delete_idx").on(table.deleteToken),
    index("todo_talk_threads_purge_idx").on(table.purgeAfter),
  ],
);

export const todoTalkSessions = sqliteTable(
  "todo_talk_sessions",
  {
    id: text("id").primaryKey(),
    userKey: text("user_key").notNull(),
    threadId: text("thread_id"),
    transport: text("transport").notNull().default("browser"),
    model: text("model").notNull(),
    voice: text("voice").notNull(),
    status: text("status").notNull().default("active"),
    lastActivityAt: text("last_activity_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    startedAt: text("started_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    endedAt: text("ended_at"),
    endReason: text("end_reason"),
  },
  (table) => [
    index("todo_talk_sessions_user_idx").on(table.userKey, table.startedAt),
    index("todo_talk_sessions_status_idx").on(table.status, table.lastActivityAt),
  ],
);

export const todoTalkMessages = sqliteTable(
  "todo_talk_messages",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    userKey: text("user_key").notNull(),
    threadId: text("thread_id"),
    realtimeItemId: text("realtime_item_id").notNull(),
    role: text("role").notNull(),
    content: text("content").notNull(),
    focusedTodoId: integer("focused_todo_id"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (table) => [
    uniqueIndex("todo_talk_messages_realtime_idx").on(table.userKey, table.realtimeItemId),
    index("todo_talk_messages_session_idx").on(table.sessionId, table.createdAt),
    index("todo_talk_messages_user_idx").on(table.userKey, table.createdAt),
    index("todo_talk_messages_thread_idx").on(table.threadId, table.createdAt),
    index("todo_talk_messages_task_idx").on(table.focusedTodoId, table.createdAt),
  ],
);

export const todoTalkToolCalls = sqliteTable(
  "todo_talk_tool_calls",
  {
    callId: text("call_id").primaryKey(),
    sessionId: text("session_id").notNull(),
    userKey: text("user_key").notNull(),
    threadId: text("thread_id"),
    name: text("name").notNull(),
    argumentsJson: text("arguments_json").notNull(),
    status: text("status").notNull().default("running"),
    resultJson: text("result_json"),
    undoToken: text("undo_token"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    completedAt: text("completed_at"),
  },
  (table) => [
    index("todo_talk_tool_calls_session_idx").on(table.sessionId, table.createdAt),
    index("todo_talk_tool_calls_user_idx").on(table.userKey, table.createdAt),
    index("todo_talk_tool_calls_thread_idx").on(table.threadId, table.createdAt),
  ],
);

export const todoTalkPhoneProfiles = sqliteTable("todo_talk_phone_profiles", {
  userKey: text("user_key").primaryKey(),
  pinHash: text("pin_hash").notNull(),
  pinSalt: text("pin_salt").notNull(),
  pinIterations: integer("pin_iterations").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  webhookUrl: text("webhook_url"),
  providerConfiguredAt: text("provider_configured_at"),
  pinUpdatedAt: text("pin_updated_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  lastAuthenticatedAt: text("last_authenticated_at"),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
});

export const todoProfileContacts = sqliteTable(
  "todo_profile_contacts",
  {
    userKey: text("user_key").primaryKey(),
    phoneCiphertext: text("phone_ciphertext"),
    phoneIv: text("phone_iv"),
    phoneHash: text("phone_hash"),
    phoneSuffix: text("phone_suffix"),
    phoneVerifiedAt: text("phone_verified_at"),
    urgentAlertsEnabled: integer("urgent_alerts_enabled", { mode: "boolean" }).notNull().default(false),
    callWindowStart: integer("call_window_start").notNull().default(8),
    callWindowEnd: integer("call_window_end").notNull().default(22),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (table) => [index("todo_profile_contacts_phone_hash_idx").on(table.phoneHash)],
);

export const todoProfilePhoneVerifications = sqliteTable(
  "todo_profile_phone_verifications",
  {
    id: text("id").primaryKey(),
    userKey: text("user_key").notNull(),
    phoneCiphertext: text("phone_ciphertext").notNull(),
    phoneIv: text("phone_iv").notNull(),
    phoneHash: text("phone_hash").notNull(),
    phoneSuffix: text("phone_suffix").notNull(),
    codeHash: text("code_hash").notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
    expiresAt: text("expires_at").notNull(),
    consumedAt: text("consumed_at"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (table) => [
    index("todo_profile_phone_verifications_user_idx").on(table.userKey, table.createdAt),
    index("todo_profile_phone_verifications_expiry_idx").on(table.expiresAt),
  ],
);

export const todoUrgentEscalations = sqliteTable(
  "todo_urgent_escalations",
  {
    id: text("id").primaryKey(),
    todoId: integer("todo_id").notNull(),
    userKey: text("user_key").notNull(),
    sourceTokenId: text("source_token_id"),
    sourceAgentName: text("source_agent_name").notNull(),
    replyCode: text("reply_code").notNull(),
    state: text("state").notNull().default("pending"),
    waveIndex: integer("wave_index").notNull().default(0),
    nextAttemptAt: text("next_attempt_at").notNull(),
    leaseToken: text("lease_token"),
    leaseExpiresAt: text("lease_expires_at"),
    lastAttemptAt: text("last_attempt_at"),
    acknowledgedAt: text("acknowledged_at"),
    acknowledgementChannel: text("acknowledgement_channel"),
    stoppedReason: text("stopped_reason"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (table) => [
    uniqueIndex("todo_urgent_escalations_todo_idx").on(table.todoId),
    uniqueIndex("todo_urgent_escalations_reply_idx").on(table.replyCode),
    index("todo_urgent_escalations_due_idx").on(table.state, table.nextAttemptAt),
    index("todo_urgent_escalations_user_idx").on(table.userKey, table.createdAt),
    index("todo_urgent_escalations_lease_idx").on(table.leaseExpiresAt),
  ],
);

export const todoUrgentAttempts = sqliteTable(
  "todo_urgent_attempts",
  {
    id: text("id").primaryKey(),
    escalationId: text("escalation_id").notNull(),
    waveIndex: integer("wave_index").notNull(),
    channel: text("channel").notNull(),
    providerSid: text("provider_sid"),
    status: text("status").notNull().default("prepared"),
    submittedAt: text("submitted_at"),
    deliveredAt: text("delivered_at"),
    errorCode: text("error_code"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (table) => [
    uniqueIndex("todo_urgent_attempts_wave_channel_idx").on(table.escalationId, table.waveIndex, table.channel),
    index("todo_urgent_attempts_provider_idx").on(table.providerSid),
    index("todo_urgent_attempts_status_idx").on(table.status, table.updatedAt),
  ],
);

export const todoTalkPhoneCalls = sqliteTable(
  "todo_talk_phone_calls",
  {
    callSid: text("call_sid").primaryKey(),
    userKey: text("user_key"),
    fromNumberHash: text("from_number_hash").notNull(),
    toNumber: text("to_number").notNull(),
    status: text("status").notNull().default("pin_pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    mode: text("mode"),
    modeAttemptCount: integer("mode_attempt_count").notNull().default(0),
    streamTokenHash: text("stream_token_hash"),
    streamTokenExpiresAt: text("stream_token_expires_at"),
    streamTokenConsumedAt: text("stream_token_consumed_at"),
    transport: text("transport").notNull().default("media"),
    providerCallId: text("provider_call_id"),
    talkSessionId: text("talk_session_id"),
    startedAt: text("started_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    authenticatedAt: text("authenticated_at"),
    connectedAt: text("connected_at"),
    endedAt: text("ended_at"),
    failureReason: text("failure_reason"),
  },
  (table) => [
    index("todo_talk_phone_calls_user_idx").on(table.userKey, table.startedAt),
    index("todo_talk_phone_calls_source_idx").on(table.fromNumberHash, table.startedAt),
    index("todo_talk_phone_calls_status_idx").on(table.status, table.startedAt),
    index("todo_talk_phone_calls_stream_idx").on(table.streamTokenHash),
    index("todo_talk_phone_calls_provider_idx").on(table.providerCallId),
  ],
);

export const todoTalkPhoneRecordings = sqliteTable(
  "todo_talk_phone_recordings",
  {
    callSid: text("call_sid").primaryKey(),
    userKey: text("user_key").notNull(),
    status: text("status").notNull().default("recording"),
    expectedSegments: integer("expected_segments"),
    taskId: integer("task_id"),
    taskClientId: text("task_client_id").notNull(),
    totalDurationMs: integer("total_duration_ms").notNull().default(0),
    processingAttempts: integer("processing_attempts").notNull().default(0),
    processingStartedAt: text("processing_started_at"),
    nextRetryAt: text("next_retry_at"),
    completedAt: text("completed_at"),
    errorCode: text("error_code"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (table) => [
    index("todo_talk_phone_recordings_status_idx").on(table.status, table.nextRetryAt),
    index("todo_talk_phone_recordings_user_idx").on(table.userKey, table.createdAt),
    uniqueIndex("todo_talk_phone_recordings_client_idx").on(table.taskClientId),
  ],
);

export const todoTalkPhoneRecordingSegments = sqliteTable(
  "todo_talk_phone_recording_segments",
  {
    recordingSid: text("recording_sid").primaryKey(),
    callSid: text("call_sid").notNull(),
    segmentIndex: integer("segment_index").notNull(),
    status: text("status").notNull().default("pending"),
    durationMs: integer("duration_ms").notNull().default(0),
    byteSize: integer("byte_size").notNull().default(0),
    attachmentId: text("attachment_id"),
    transcriptText: text("transcript_text"),
    twilioDeletedAt: text("twilio_deleted_at"),
    errorCode: text("error_code"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (table) => [
    uniqueIndex("todo_talk_phone_recording_segments_order_idx").on(table.callSid, table.segmentIndex),
    index("todo_talk_phone_recording_segments_status_idx").on(table.callSid, table.status),
    index("todo_talk_phone_recording_segments_cleanup_idx").on(table.twilioDeletedAt, table.updatedAt),
  ],
);

export const todoAssistantMemories = sqliteTable(
  "todo_assistant_memories",
  {
    id: text("id").primaryKey(),
    userKey: text("user_key").notNull(),
    scope: text("scope").notNull(),
    todoId: integer("todo_id"),
    kind: text("kind").notNull().default("fact"),
    content: text("content").notNull(),
    provenanceJson: text("provenance_json").notNull().default("{}"),
    dedupeKey: text("dedupe_key").notNull(),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    forgottenAt: text("forgotten_at"),
  },
  (table) => [
    uniqueIndex("todo_assistant_memories_dedupe_idx").on(table.userKey, table.dedupeKey),
    index("todo_assistant_memories_user_idx").on(table.userKey, table.updatedAt),
    index("todo_assistant_memories_task_idx").on(table.userKey, table.todoId, table.updatedAt),
    index("todo_assistant_memories_forgotten_idx").on(table.forgottenAt),
  ],
);
