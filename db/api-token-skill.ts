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
description: Manage the owner's Dawar Todo system through its authenticated API. Use when asked to inspect, create, edit, complete, reopen, snooze, merge, reassign, or delete tasks; manage projects and attachments; change snooze settings; or manage public calendar feeds.
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

Send it on every API request:

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
- A snoozed task remains \`open\` and has a future \`snoozedUntil\` timestamp.
- \`priority\`: 1 urgent, 2 high, 3 normal, 4 low.
- \`dueDate\`: \`YYYY-MM-DD\` or null.
- \`project\`: a registered project name or null for unassigned.
- \`attachmentCount\`: count only; load attachment metadata separately.
- New tasks must have non-empty text and start open.
- Use a UUID \`clientId\` when retries might repeat a create request.

## Endpoints

### Todos

- \`GET /api/todos\`: list all open, snoozed, and completed tasks.
- \`POST /api/todos\`: create an open task. Supports title, notes, priority, dueDate, project, context, clientId, draftToken, and attachmentIds.
- \`PATCH /api/todos/{id}\`: edit title, notes, status, priority, dueDate, project, or context. Set nullable fields to null to clear them.
- \`POST /api/todos/bulk\`: perform state and multi-task operations.
- \`POST /api/todos/undo\`: consume a returned Undo token.

Bulk actions:

- \`complete\`: mark IDs completed and clear snooze.
- \`unsnooze\`: wake snoozed IDs or reopen completed IDs.
- \`snooze\`: snooze IDs until the configured next-day wake time.
- \`adjust_snooze\`: change already-snoozed IDs using \`snoozePreset\`: \`15m\`, \`30m\`, \`1h\`, \`2h\`, or \`8pm\`.
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

- \`GET /api/todos/{id}/attachments\`: list metadata and temporary signed viewing/download URLs.
- \`POST /api/todos/{id}/attachments\`: prepare a private upload.
- Upload each returned target as multipart form data using its exact \`fields\`, followed by the binary \`file\` field. Do not send the Dawar Todo Bearer token to storage URLs.
- \`PATCH /api/todos/{id}/attachments\`: finalize after every required storage upload succeeds.
- \`DELETE /api/todos/{id}/attachments/{attachmentId}\`: soft-delete an attachment and retain its Undo token.
- Use \`/api/attachments/drafts\` with a UUID \`draftToken\` to upload before task creation, then pass that token and ordered attachment IDs to \`POST /api/todos\`.

Images require original, optimized display, and thumbnail uploads. Audio and video require the original upload. Use the OpenAPI schemas for required MIME, dimensions, duration, and size fields.

### Settings and calendars

- \`GET /api/settings\` and \`PATCH /api/settings\`: read or change snooze timezone and next-day wake hour.
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
- Treat signed attachment URLs as temporary secrets.
- On 401, stop and ask for a fresh skill/token. Do not retry repeatedly.
- On 409 from Undo, report that the token expired or was already used.
- On partial failure, re-read affected records before retrying.
- Never manage API tokens through this credential; token creation, recovery, and revocation require the owner's ChatGPT-authenticated Settings screen.
`;
}
