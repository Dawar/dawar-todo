import type { ApiToken } from "./api-tokens";

const API_ORIGIN = "https://work.dawar.ca";
const API_BASE_URL = `${API_ORIGIN}/api`;
const OPENAPI_URL = `${API_ORIGIN}/openapi.json`;

function markdownText(value: string) {
  return value.replace(/[\r\n]+/g, " ").replace(/`/g, "'").trim();
}

export function apiTokenSkill(apiToken: ApiToken, token: string) {
  const tokenName = markdownText(apiToken.name);
  return `---
name: dawar-todo
description: Manage the owner's Dawar Todo system through its authenticated API. Use when asked to inspect, create, edit, complete, reopen, schedule, snooze, merge, reassign, or delete tasks; manage projects and attachments; change settings; or manage public calendar feeds.
---

# Dawar Todo

Use the Dawar Todo API for todo-list work. This skill contains a private credential with full read/write access.

## Connection

- API base URL: ${API_BASE_URL}
- OpenAPI specification: ${OPENAPI_URL}
- Token name: ${tokenName}
- Authentication: HTTP Bearer

Set or retain this credential privately:

\`\`\`text
DAWAR_TODO_API_TOKEN=${token}
\`\`\`

Send it on every Dawar Todo API request. Add \`Content-Type: application/json\` only for JSON bodies; let the HTTP client set the multipart boundary for file uploads:

\`\`\`http
Authorization: Bearer ${token}
Content-Type: application/json
\`\`\`

Never reveal, quote, log, or send this token anywhere except ${API_ORIGIN}. If a request redirects to another origin, do not forward the Authorization header.

## Start here

1. Read ${OPENAPI_URL} when exact request or response schemas are needed.
2. Call \`GET ${API_BASE_URL}/todos\` to understand current state before changing it.
3. Call \`GET ${API_BASE_URL}/projects\` before assigning or creating projects.
4. Preserve fields the user did not ask to change.
5. Keep every returned \`undoToken\` until the work is confirmed.
6. Summarize the exact records changed and any assumptions made.

Example health check:

\`\`\`bash
curl --fail-with-body \\
  -H 'Authorization: Bearer ${token}' \\
  -H 'Accept: application/json' \\
  '${API_BASE_URL}/todos'
\`\`\`

## Task model

- \`status\`: \`open\` or \`completed\`.
- A snoozed task remains \`open\` and has a future \`snoozedUntil\` timestamp. Once that time passes, normal list/sync reads automatically clear the snooze and return the task to Open.
- \`recurrenceCron\`: an optional five-field cron expression (minute, hour, day, month, weekday) evaluated in the user's configured \`snoozeTimeZone\`. At each matching interval, a completed task reopens. Recurring tasks cannot be snoozed.
- \`priority\`: 1 urgent, 2 high, 3 normal, 4 low.
- \`dueDate\`: \`YYYY-MM-DD\` or null.
- \`project\`: a registered project name or null for unassigned.
- \`pinned\`: when true, the task is hoisted into the Pinned group in the Open view. It has no effect on task state or other views.
- \`attachmentCount\`: count only; load attachment metadata separately.
- New tasks must have non-empty text and start open.
- Use a UUID \`clientId\` when retries might repeat a create request.

## Endpoints

### Todos

- \`GET /api/todos\`: list all open, snoozed, and completed tasks.
- \`POST /api/todos\`: create an open task. Supports title, notes, priority, dueDate, project, context, recurrenceCron, clientId, draftToken, and attachmentIds.
- \`PATCH /api/todos/{id}\`: edit title, notes, status, priority, dueDate, project, context, recurrenceCron, or pinned. Set nullable fields to null to clear them. For offline or concurrent clients, include a UUID \`mutation.mutationId\` and per-field ISO timestamps in \`mutation.fieldTimestamps\`; independent fields merge and same-field conflicts resolve deterministically.
- \`POST /api/todos/bulk\`: perform state and multi-task operations.
- \`POST /api/todos/undo\`: consume a returned Undo token.

Bulk actions:

- \`complete\`: mark IDs completed and clear snooze.
- \`unsnooze\`: wake snoozed IDs or reopen completed IDs.
- \`snooze\`: snooze non-recurring IDs until the configured next-day wake time. The API rejects recurring tasks.
- \`adjust_snooze\`: change already-snoozed IDs with either \`snoozePreset\` (\`15m\`, \`30m\`, \`45m\`, \`1h\`, \`90m\`, \`2h\`, \`3h\`, \`4h\`, \`6h\`, \`8h\`, or \`12h\`) or \`snoozedLocal\` in \`YYYY-MM-DDTHH:mm\` form. Custom local times are interpreted in the user's configured timezone. The legacy \`8pm\` preset remains accepted for backward compatibility.
- \`reproject\`: set \`project\` to a name or null without changing status or snooze.
- \`merge\`: create one merged task and delete the source IDs.
- \`delete\`: delete selected IDs.

Prefer one bulk request over many individual requests. Bulk operations accept at most 200 unique positive IDs.

### Projects

- \`GET /api/projects\`: list project names.
- \`POST /api/projects\`: create a project with \`{ "name": "..." }\`.
- \`DELETE /api/projects\`: delete a project using mode \`reassign\` with \`targetProject\`, or mode \`delete\` to delete its tasks.

Project deletion affects open, snoozed, and completed tasks. Inspect those tasks first and avoid destructive deletion unless the user clearly requested it.

### Attachments

- \`POST /api/todos/{id}/attachments\` with multipart form data is the preferred agent path: send one \`file\` and receive a ready attachment in one request. The server creates image thumbnails/viewer renditions automatically. It stores voice memos and generic files as supplied.
- \`kind\` is normally inferred. Set \`kind=audio\` and include \`durationMs\` for a voice memo when the client does not provide a useful audio MIME type. Use the optional \`mimeType\` field when the upload would otherwise be \`application/octet-stream\`.
- \`GET /api/todos/{id}/attachments\`: list metadata and fresh one-hour viewing/download URLs. Download any kind from \`originalUrl\`; use \`displayUrl\` for optimized images and \`audioUrl\` or \`videoUrl\` for inline playback.
- Never send the Dawar Todo Bearer token to a returned storage URL. The signed URL already authorizes that one download.
- \`PATCH /api/todos/{id}/attachments\`: finalize after every required storage upload succeeds.
- \`DELETE /api/todos/{id}/attachments/{attachmentId}\`: soft-delete an attachment and retain its Undo token.
- Use \`/api/attachments/drafts\` with a UUID \`draftToken\` to upload before task creation, then pass that token and ordered attachment IDs to \`POST /api/todos\`.

Create a task and attach a local file in two commands:

\`\`\`bash
TASK_ID=$(curl --fail-with-body -sS \\
  -H 'Authorization: Bearer ${token}' \\
  -H 'Content-Type: application/json' \\
  -d '{"title":"Review attached report"}' \\
  '${API_BASE_URL}/todos' | jq -r '.todo.id')

curl --fail-with-body -sS \\
  -H 'Authorization: Bearer ${token}' \\
  -F 'file=@/absolute/path/report.pdf' \\
  "${API_BASE_URL}/todos/$TASK_ID/attachments"
\`\`\`

Use the same multipart command for JPEG, PNG, WebP, GIF, HEIC, or HEIF images; no dimensions or derivative files are needed.

For a voice memo:

\`\`\`bash
curl --fail-with-body -sS \\
  -H 'Authorization: Bearer ${token}' \\
  -F 'file=@/absolute/path/memo.m4a' \\
  -F 'kind=audio' \\
  -F 'durationMs=42000' \\
  "${API_BASE_URL}/todos/$TASK_ID/attachments"
\`\`\`

Retrieve metadata and download the original without forwarding the API token:

\`\`\`bash
DOWNLOAD_URL=$(curl --fail-with-body -sS \\
  -H 'Authorization: Bearer ${token}' \\
  "${API_BASE_URL}/todos/$TASK_ID/attachments" | jq -r '.attachments[0].originalUrl')
curl --fail-with-body -L "$DOWNLOAD_URL" -o attachment
\`\`\`

Each multipart request accepts one file; repeat it to attach more files, up to 12 per task. Images are limited to 20 MB, voice memos to 50 MB and 30 minutes, videos to 250 MB and 60 minutes, and generic files to 100 MB. Generic files support PDF, Office, OpenDocument, text, calendar, ZIP, and 7z formats. The lower-level JSON prepare/upload/finalize flow remains available for browser clients; agents should normally use multipart.

### Settings and calendars

- \`GET /api/settings\` and \`PATCH /api/settings\`: read or change the timezone used by snooze and recurring schedules, the next-day wake hour, and exactly four distinct \`snoozeQuickPresets\`. Quick presets are returned shortest-to-longest.
- \`GET /api/calendar-feeds\`: list active public iCal feeds.
- \`POST /api/calendar-feeds\`: create a feed.
- \`PATCH /api/calendar-feeds/{id}\`: regenerate its public token and invalidate the old URL.
- \`DELETE /api/calendar-feeds/{id}\`: revoke a feed.

## Safe operating rules

- Resolve ambiguity before bulk deletion, project deletion, merge, or mass reassignment.
- Read current records before intelligence-based sorting or large edits.
- Do not infer completion solely from age; preserve user intent.
- Use project null to remove assignment, not an invented "Unassigned" project.
- Use dueDate null to clear a due date.
- Validate recurrenceCron before writing it, and never attempt to snooze a task while recurrenceCron is set.
- When replaying offline edits, retain the original field timestamps and mutation ID. Inspect \`appliedFields\` to see which values won conflict resolution, then re-read the task.
- Treat signed attachment URLs as temporary secrets.
- On 401, stop and ask for a fresh skill/token. Do not retry repeatedly.
- On 409 from Undo, report that the token expired or was already used.
- On partial failure, re-read affected records before retrying.
- Never manage API tokens through this credential; token creation and revocation require the owner's ChatGPT-authenticated Settings screen. The token and credentialed SKILL.md are shown only once at creation.
`;
}
