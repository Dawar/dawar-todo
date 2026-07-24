import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { appAccessResponse } from "../worker/access.ts";

const root = new URL("../", import.meta.url);

test("ships a persistent source-aware task assistant workspace", async () => {
  const [
    schema,
    database,
    assistantDb,
    runtime,
    workspace,
    offline,
    header,
    migration,
    draftMigration,
    serviceWorker,
  ] = await Promise.all([
    readFile(new URL("db/schema.ts", root), "utf8"),
    readFile(new URL("db/todos.ts", root), "utf8"),
    readFile(new URL("db/assistant.ts", root), "utf8"),
    readFile(new URL("lib/assistant-runtime.ts", root), "utf8"),
    readFile(new URL("app/assistant/workspace.tsx", root), "utf8"),
    readFile(new URL("app/offline-store.ts", root), "utf8"),
    readFile(new URL("app/site-header.tsx", root), "utf8"),
    readFile(new URL("drizzle/0017_famous_praxagora.sql", root), "utf8"),
    readFile(new URL("drizzle/0018_parched_human_fly.sql", root), "utf8"),
    readFile(new URL("public/sw.js", root), "utf8"),
  ]);

  assert.match(schema, /todoAssistantWorkspaces/);
  assert.match(schema, /todoAssistantThreads/);
  assert.match(schema, /todoAssistantMessages/);
  assert.match(database, /CREATE TABLE IF NOT EXISTS todo_assistant_workspaces/);
  assert.match(database, /CREATE TABLE IF NOT EXISTS todo_assistant_threads/);
  assert.match(database, /CREATE TABLE IF NOT EXISTS todo_assistant_messages/);
  assert.match(migration, /CREATE TABLE `todo_assistant_messages`/);
  assert.match(draftMigration, /draft_attachment_ids_json/);
  assert.match(assistantDb, /currentQuestionJson|current_question_json/);
  assert.match(assistantDb, /skippedQuestionKeysJson|skipped_question_keys_json/);
  assert.match(assistantDb, /understandingJson|understanding_json/);
  assert.match(assistantDb, /idempotent message replay resolved/);

  assert.match(runtime, /gpt-5\.6-terra/);
  assert.match(runtime, /\/v1\/responses/);
  assert.match(runtime, /reasoning: \{ effort: "low" \}/);
  assert.match(runtime, /json_schema/);
  assert.match(runtime, /Ask at most one valuable question/);
  assert.match(runtime, /Never send messages, submit forms, purchase, book, publish/);
  assert.match(runtime, /requires user confirmation/);
  assert.match(runtime, /userFacts/);
  assert.match(runtime, /attachmentFacts/);
  assert.match(runtime, /inferences/);
  assert.match(runtime, /web_search/);
  assert.match(runtime, /gpt-4o-transcribe/);
  assert.match(runtime, /input_image/);
  assert.match(runtime, /input_file/);

  assert.match(workspace, /lg:grid-cols-\[340px_minmax\(0,1fr\)\]/);
  assert.match(workspace, /Independent/);
  assert.match(workspace, /Skip · next question/);
  assert.match(workspace, /Keep task as is/);
  assert.match(workspace, /Apply to task/);
  assert.match(workspace, /Record voice memo/);
  assert.match(workspace, /onPaste/);
  assert.match(workspace, /onDrop=\{drop\}/);
  assert.match(workspace, /Tasks can have up to 12 attachments/);
  assert.match(offline, /assistant-queue/);
  assert.match(offline, /assistant-draft/);
  assert.match(header, /AI task assistant/);
  assert.match(serviceWorker, /"\/assistant"/);
});

test("does not permit API bearer tokens to spend assistant model capacity", async () => {
  const response = await appAccessResponse(new Request("https://work.dawar.ca/api/assistant/messages", {
    method: "POST",
    headers: { Authorization: `Bearer dt_live_${"A".repeat(43)}` },
  }), { DB: {} });
  assert.equal(response?.status, 403);
  assert.match(await response.text(), /signed-in Dawar Todo interface/);
});
