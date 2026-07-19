import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("stores private task images with optimized variants and recovery metadata", async () => {
  const [attachments, todos, schema, migration, uploadMigration, hosting, packageJson] = await Promise.all([
    readFile(new URL("db/attachments.ts", root), "utf8"),
    readFile(new URL("db/todos.ts", root), "utf8"),
    readFile(new URL("db/schema.ts", root), "utf8"),
    readFile(new URL("drizzle/0004_abnormal_onslaught.sql", root), "utf8"),
    readFile(new URL("drizzle/0005_opposite_rockslide.sql", root), "utf8"),
    readFile(new URL(".openai/hosting.json", root), "utf8"),
    readFile(new URL("package.json", root), "utf8"),
  ]);

  assert.match(schema, /todoAttachments = sqliteTable/);
  assert.match(migration, /CREATE TABLE `todo_attachments`/);
  assert.match(migration, /todo_attachments_todo_id_idx/);
  assert.match(migration, /todo_attachments_draft_token_idx/);
  assert.match(migration, /todo_attachments_expires_at_idx/);
  assert.match(migration, /todo_attachments_deleted_at_idx/);
  assert.match(uploadMigration, /ADD `upload_state` text DEFAULT 'ready' NOT NULL/);
  assert.match(hosting, /"r2": null/);
  assert.doesNotMatch(packageJson, /aws4fetch|@aws-sdk\/client-s3|@aws-sdk\/s3-request-presigner/);
  assert.match(attachments, /S3_ACCESS_KEY/);
  assert.match(attachments, /S3_ACCESS_KEY_ID/);
  assert.match(attachments, /S3_BUCKET/);
  assert.match(attachments, /S3_ENDPOINT_URL/);
  assert.match(attachments, /endpointUrl\.hostname\.startsWith\(bucketPrefix\)/);
  assert.match(attachments, /endpointUrl\.hostname\.endsWith\("\.digitaloceanspaces\.com"\)/);
  assert.match(attachments, /signingRegion = endpointUrl\.hostname\.endsWith/);
  assert.match(attachments, /\? "us-east-1"/);
  assert.match(attachments, /region: signingRegion/);
  assert.match(attachments, /url\.hostname = `\$\{bucket\}\.\$\{url\.hostname\}`/);
  assert.match(attachments, /signedQueryUrl/);
  assert.match(attachments, /canonicalRequest/);
  assert.match(attachments, /UNSIGNED-PAYLOAD/);
  assert.match(attachments, /signedPostTarget/);
  assert.match(attachments, /AWS4-HMAC-SHA256/);
  assert.match(attachments, /content-length-range/);
  assert.match(attachments, /originalSize !== row\.byte_size/);
  assert.match(attachments, /storageFetch/);
  assert.match(attachments, /signedStorageResponse/);
  assert.match(attachments, /signedQueryUrl\(url, method, 300\)/);
  assert.match(attachments, /url\.searchParams\.set\("X-Amz-Expires", String\(expires\)\)/);
  assert.match(attachments, /storageResponseError/);
  assert.match(attachments, /prepareTodoAttachmentUpload/);
  assert.match(attachments, /finalizeTodoAttachmentUpload/);
  assert.match(attachments, /SIGNED_URL_SECONDS = 60 \* 60/);
  assert.doesNotMatch(attachments, /public-read|ACL:/);
  assert.doesNotMatch(attachments, /S3_CDN_URL.*replace|url\.hostname = cdnHost/);
  assert.match(attachments, /MAX_ATTACHMENTS_PER_TASK = 12/);
  assert.match(attachments, /MAX_ATTACHMENT_BYTES = 20 \* 1024 \* 1024/);
  assert.match(attachments, /"image\/jpeg", "image\/png", "image\/webp", "image\/gif", "image\/heic", "image\/heif"/);
  assert.match(attachments, /expiresAt.*DRAFT_LIFETIME_HOURS/s);
  assert.match(attachments, /upload_state = 'ready'/);
  assert.match(attachments, /detectedImageFormat/);
  assert.match(attachments, /inspectedImageDimensions/);
  assert.match(attachments, /Math\.max\(displayDimensions\.width, displayDimensions\.height\) > 2048/);
  assert.match(attachments, /Math\.max\(thumbnailDimensions\.width, thumbnailDimensions\.height\) > 480/);
  assert.match(attachments, /invalid direct upload cleanup failed/);
  assert.match(attachments, /deleted_at.*DELETED_RETENTION_DAYS/s);
  assert.match(attachments, /upload_state = 'uploading'.*expires_at/s);
  assert.match(todos, /attachments\?: AttachmentRow\[\]/);
  assert.match(todos, /attachmentsMoved/);
  assert.match(todos, /restoreAttachmentStatements/);
  assert.match(todos, /restoredAttachments/);
});

test("exposes capture, mobile camera, paste, gallery, and viewer contracts", async () => {
  const [page, actionIcons, draftRoute, taskAttachmentsRoute, attachmentRoute, todosRoute] = await Promise.all([
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("app/action-icon.tsx", root), "utf8"),
    readFile(new URL("app/api/attachments/drafts/route.ts", root), "utf8"),
    readFile(new URL("app/api/todos/[id]/attachments/route.ts", root), "utf8"),
    readFile(new URL("app/api/todos/[id]/attachments/[attachmentId]/route.ts", root), "utf8"),
    readFile(new URL("app/api/todos/route.ts", root), "utf8"),
  ]);

  assert.match(page, /function AttachmentPicker/);
  assert.match(page, /Photo library/);
  assert.match(page, /Take photo/);
  assert.match(page, /capture="environment"/);
  assert.match(page, /multiple className="sr-only"/);
  assert.match(page, /onPaste=\{\(event\) =>/);
  assert.match(page, /queueCaptureImages\(files\)/);
  assert.match(page, /queueDetailImages\(files\)/);
  assert.match(page, /canvasWebp\(source, width, height, 2048, 0\.82\)/);
  assert.match(page, /canvasWebp\(source, width, height, 480, 0\.75\)/);
  assert.match(page, /Promise\.allSettled/);
  assert.match(page, /method: "POST", mode: "no-cors"/);
  assert.match(page, /postPrivateVariant/);
  assert.match(page, /uploadPrivateImage/);
  assert.match(page, /new FormData\(\)/);
  assert.match(page, /captureAttachments\.some\(\(item\) => item\.status !== "ready"\)/);
  assert.match(page, /attachmentCount/);
  assert.match(page, /Task details/);
  assert.match(page, /task-images-heading/);
  assert.match(page, /Image viewer:/);
  assert.match(page, /Download original/);
  assert.match(page, /viewerGesture/);
  assert.match(actionIcons, /ImagePlus/);
  assert.match(actionIcons, /Camera/);
  assert.match(actionIcons, /Download/);
  assert.match(draftRoute, /prepareTodoAttachmentUpload/);
  assert.match(draftRoute, /finalizeTodoAttachmentUpload/);
  assert.doesNotMatch(draftRoute, /formData\(\)/);
  assert.match(taskAttachmentsRoute, /listTodoAttachments/);
  assert.match(taskAttachmentsRoute, /prepareTodoAttachmentUpload/);
  assert.match(taskAttachmentsRoute, /finalizeTodoAttachmentUpload/);
  assert.doesNotMatch(taskAttachmentsRoute, /formData\(\)/);
  assert.match(attachmentRoute, /deleteTodoAttachment/);
  assert.match(attachmentRoute, /discardTodoAttachmentUpload/);
  assert.match(todosRoute, /draftToken/);
  assert.match(todosRoute, /attachmentIds/);
});
