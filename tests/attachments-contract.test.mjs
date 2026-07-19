import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("stores private task images with optimized variants and recovery metadata", async () => {
  const [attachments, todos, schema, migration, uploadMigration, mediaMigration, hosting, packageJson] = await Promise.all([
    readFile(new URL("db/attachments.ts", root), "utf8"),
    readFile(new URL("db/todos.ts", root), "utf8"),
    readFile(new URL("db/schema.ts", root), "utf8"),
    readFile(new URL("drizzle/0004_abnormal_onslaught.sql", root), "utf8"),
    readFile(new URL("drizzle/0005_opposite_rockslide.sql", root), "utf8"),
    readFile(new URL("drizzle/0006_square_kang.sql", root), "utf8"),
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
  assert.match(mediaMigration, /ADD `kind` text DEFAULT 'image' NOT NULL/);
  assert.match(mediaMigration, /ADD `duration_ms` integer DEFAULT 0 NOT NULL/);
  assert.match(mediaMigration, /ADD `client_id` text/);
  assert.match(mediaMigration, /todos_client_id_idx/);
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
  assert.match(attachments, /serverUrl\.hostname = endpoint\.hostname/);
  assert.match(attachments, /serverUrl\.pathname = `\/\$\{encodeURIComponent\(bucket\)\}\$\{url\.pathname\}`/);
  assert.match(attachments, /signedHeaderRequest/);
  assert.match(attachments, /x-amz-content-sha256/);
  assert.match(attachments, /host;x-amz-content-sha256;x-amz-date/);
  assert.match(attachments, /headers\.set\("Authorization"/);
  assert.match(attachments, /canonicalRequest/);
  assert.match(attachments, /UNSIGNED-PAYLOAD/);
  assert.match(attachments, /signedPostTarget/);
  assert.match(attachments, /AWS4-HMAC-SHA256/);
  assert.match(attachments, /content-length-range/);
  assert.match(attachments, /originalSize !== row\.byte_size/);
  assert.match(attachments, /storageFetch/);
  assert.match(attachments, /signedStorageResponse/);
  assert.match(attachments, /signedHeaderRequest\(serverUrl, method, init\?\.headers\)/);
  assert.match(attachments, /url\.searchParams\.set\("X-Amz-Expires", String\(expires\)\)/);
  assert.match(attachments, /storageResponseError/);
  assert.match(attachments, /prepareTodoAttachmentUpload/);
  assert.match(attachments, /finalizeTodoAttachmentUpload/);
  assert.match(attachments, /prepareTodoMediaAttachmentUpload/);
  assert.match(attachments, /finalizeTodoMediaAttachmentUpload/);
  assert.match(attachments, /MAX_AUDIO_ATTACHMENT_BYTES = 50 \* 1024 \* 1024/);
  assert.match(attachments, /MAX_VIDEO_ATTACHMENT_BYTES = 250 \* 1024 \* 1024/);
  assert.match(attachments, /detectedMediaFormat/);
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
  assert.match(attachments, /normalizedDerivativeMimeType/);
  assert.match(attachments, /Optimized images must be WebP or JPEG/);
  assert.match(attachments, /display\.\$\{extensionForMimeType\(displayMimeType\)\}/);
  assert.match(attachments, /thumb\.\$\{extensionForMimeType\(thumbnailMimeType\)\}/);
  assert.match(attachments, /displayFormat !== expectedDisplayFormat/);
  assert.match(attachments, /thumbnailFormat !== expectedThumbnailFormat/);
  assert.match(attachments, /Math\.max\(displayDimensions\.width, displayDimensions\.height\) > 2048/);
  assert.match(attachments, /Math\.max\(thumbnailDimensions\.width, thumbnailDimensions\.height\) > 480/);
  assert.match(attachments, /invalid direct upload cleanup failed/);
  assert.match(attachments, /deleted_at.*DELETED_RETENTION_DAYS/s);
  assert.match(attachments, /upload_state = 'uploading'.*expires_at/s);
  assert.match(todos, /attachments\?: AttachmentRow\[\]/);
  assert.match(todos, /attachmentsMoved/);
  assert.match(todos, /restoreAttachmentStatements/);
  assert.match(todos, /restoredAttachments/);
  assert.match(todos, /idempotent offline create replay resolved/);
  assert.match(todos, /CREATE UNIQUE INDEX IF NOT EXISTS todos_client_id_idx/);
});

test("exposes capture, Safari-safe optimization, drop, gallery, and viewer contracts", async () => {
  const [page, actionIcons, draftRoute, taskAttachmentsRoute, attachmentRoute, todosRoute] = await Promise.all([
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("app/action-icon.tsx", root), "utf8"),
    readFile(new URL("app/api/attachments/drafts/route.ts", root), "utf8"),
    readFile(new URL("app/api/todos/[id]/attachments/route.ts", root), "utf8"),
    readFile(new URL("app/api/todos/[id]/attachments/[attachmentId]/route.ts", root), "utf8"),
    readFile(new URL("app/api/todos/route.ts", root), "utf8"),
  ]);

  assert.match(page, /function AttachmentPicker/);
  assert.match(page, /Choose photos or videos/);
  assert.match(page, /Record voice memo/);
  assert.doesNotMatch(page, /Take photo/);
  assert.doesNotMatch(page, /capture="environment"/);
  assert.match(page, /multiple className="sr-only"/);
  assert.match(page, /onPaste=\{\(event\) =>/);
  assert.match(page, /queueCaptureAttachments\(files\)/);
  assert.match(page, /queueDetailAttachments\(files\)/);
  assert.match(page, /canvasOptimizedImage\(source, width, height, 2048, 0\.82\)/);
  assert.match(page, /canvasOptimizedImage\(source, width, height, 480, 0\.75\)/);
  assert.match(page, /encodedImageFormat\(webp\) === "webp"/);
  assert.match(page, /canvasBlob\(canvas, "image\/jpeg", quality\)/);
  assert.match(page, /displayMimeType: variants\.display\.mimeType/);
  assert.match(page, /thumbnailMimeType: variants\.thumbnail\.mimeType/);
  assert.match(page, /window\.addEventListener\("dragenter", dragEnter\)/);
  assert.match(page, /window\.addEventListener\("drop", drop\)/);
  assert.match(page, /Drop photos or videos to attach to/);
  assert.match(page, /routeDroppedAttachments = useEffectEvent/);
  assert.match(page, /if \(editingId !== null\) void queueDetailAttachments\(files\)/);
  assert.match(page, /Promise\.allSettled/);
  assert.match(page, /method: "POST", mode: "no-cors"/);
  assert.match(page, /postPrivateVariant/);
  assert.match(page, /uploadPrivateImage/);
  assert.match(page, /uploadPrivateMedia/);
  assert.match(page, /function VoiceMemoRecorder/);
  assert.match(page, /MediaRecorder\.isTypeSupported/);
  assert.match(page, /audio\/mp4/);
  assert.match(page, /new FormData\(\)/);
  assert.match(page, /item\.status === "uploading" \|\| item\.status === "error"/);
  assert.match(page, /attachmentCount/);
  assert.match(page, /Task details/);
  assert.match(page, /task-attachments-heading/);
  assert.match(page, /<audio controls/);
  assert.match(page, /<video controls/);
  assert.match(page, /Image viewer:/);
  assert.match(page, /Download original/);
  assert.match(page, /viewerGesture/);
  assert.match(actionIcons, /ImagePlus/);
  assert.match(actionIcons, /Camera/);
  assert.match(actionIcons, /Download/);
  assert.match(actionIcons, /Mic/);
  assert.match(actionIcons, /Paperclip/);
  assert.match(draftRoute, /prepareTodoAttachmentUpload/);
  assert.match(draftRoute, /finalizeTodoAttachmentUpload/);
  assert.match(draftRoute, /prepareTodoMediaAttachmentUpload/);
  assert.match(draftRoute, /finalizeTodoMediaAttachmentUpload/);
  assert.match(draftRoute, /displayMimeType: payload\.displayMimeType/);
  assert.match(draftRoute, /thumbnailMimeType: payload\.thumbnailMimeType/);
  assert.doesNotMatch(draftRoute, /formData\(\)/);
  assert.match(taskAttachmentsRoute, /listTodoAttachments/);
  assert.match(taskAttachmentsRoute, /prepareTodoAttachmentUpload/);
  assert.match(taskAttachmentsRoute, /finalizeTodoAttachmentUpload/);
  assert.match(taskAttachmentsRoute, /prepareTodoMediaAttachmentUpload/);
  assert.match(taskAttachmentsRoute, /finalizeTodoMediaAttachmentUpload/);
  assert.match(taskAttachmentsRoute, /displayMimeType: payload\.displayMimeType/);
  assert.match(taskAttachmentsRoute, /thumbnailMimeType: payload\.thumbnailMimeType/);
  assert.doesNotMatch(taskAttachmentsRoute, /formData\(\)/);
  assert.match(attachmentRoute, /deleteTodoAttachment/);
  assert.match(attachmentRoute, /discardTodoAttachmentUpload/);
  assert.match(attachmentRoute, /Response\.json\(\{ attachmentId, discarded \}\)/);
  assert.match(todosRoute, /draftToken/);
  assert.match(todosRoute, /attachmentIds/);
  assert.match(todosRoute, /clientId/);
});

test("installs an offline-capable PWA with idempotent queued task syncing", async () => {
  const [page, offlineStore, serviceWorker, manifest, layout, register, schema] = await Promise.all([
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("app/offline-store.ts", root), "utf8"),
    readFile(new URL("public/sw.js", root), "utf8"),
    readFile(new URL("public/manifest.webmanifest", root), "utf8"),
    readFile(new URL("app/layout.tsx", root), "utf8"),
    readFile(new URL("app/pwa-register.tsx", root), "utf8"),
    readFile(new URL("db/schema.ts", root), "utf8"),
  ]);

  assert.match(offlineStore, /indexedDB\.open/);
  assert.match(offlineStore, /pending-todos/);
  assert.match(offlineStore, /blob: Blob/);
  assert.match(offlineStore, /navigator\.storage\.persist/);
  assert.match(page, /saveOfflineTodo/);
  assert.match(page, /syncOfflineQueue/);
  assert.match(page, /window\.addEventListener\("online"/);
  assert.match(page, /clientId: record\.clientId/);
  assert.match(page, /Saved offline\. It will sync automatically/);
  assert.match(serviceWorker, /request\.mode === "navigate"/);
  assert.match(serviceWorker, /url\.pathname\.startsWith\("\/api\/"\)/);
  assert.match(serviceWorker, /caches\.match/);
  assert.match(manifest, /"display": "standalone"/);
  assert.match(manifest, /icon-maskable-512\.png/);
  assert.match(layout, /manifest: "\/manifest\.webmanifest"/);
  assert.match(register, /serviceWorker\.register\("\/sw\.js"/);
  assert.match(schema, /uniqueIndex\("todos_client_id_idx"\)/);
  await Promise.all([
    access(new URL("public/icons/icon-192.png", root)),
    access(new URL("public/icons/icon-512.png", root)),
    access(new URL("public/icons/icon-maskable-512.png", root)),
    access(new URL("public/icons/apple-touch-icon.png", root)),
  ]);
});
