# Secure one-time input

Installed through the existing named-bot dynamic tools and authenticated MCP catalog:

- `bots_request_secure_input`: request the minimum fields/images needed, with a purpose and declared own-desktop or HTTPS destination. Returns metadata and an opaque handle.
- `bots_use_secure_input`: use that handle privately for a named field in an observed own-desktop window, or substitute `{field:"name"}` in HTTPS headers/JSON/form and named image slots in multipart. Observe/verify desktop input normally. Reuse the same operation ID after uncertainty; a retry retrieves its outcome and never repeats input or HTTP use.
- `bots_delete_secure_input`: delete promptly when finished. Status/model-read modes are documented on the use tool. Model reading requires the human's unchecked-by-default choice, including response reading.

Never echo secrets or put them in scripts, files, ordinary attachments, queues or published artifacts. This is a transfer channel for trusted bots on the existing shared account, not a vault or stronger process isolation. Desktop screenshots remain available; website/session/autofill and explicitly permitted native/model copies survive deletion.

## Data flow and persistence

The open uncontrolled form holds values/files only in memory. Closing, switching bots or reloading disposes it. The dedicated authenticated websocket `secure` channel transports encrypted chunks, not ordinary RPC/answer/operation-journal traffic. Relay routing injects the authenticated owner and browser ID; it forwards in flight without durable-object payload storage. Browser retries retain the original submission ID and exact ciphertext until an authenticated positive receipt.

Each request generates a nonextractable bridge ECDH P-256 private key in RAM. Browser ECDH + HKDF SHA-256 derives AES-256-GCM; AAD binds protocol version, owner, bot, native thread, request and submission. SHA-256 plus per-chunk digests reject changed replays. The cloud relays ciphertext only. Existing TLS/session and relay integrity are trusted; this does not claim protection against a malicious compromised endpoint or relay replacing public keys.

Bridge fields/images, keys, responses, partial ciphertext and private-use receipts are volatile. Only sanitized descriptions/IDs, request status and receipt/expiry/model-choice metadata enter local SQLite/events/browser metadata caches. A non-sensitive, same-ID primary-intake receipt wakes the intended bot when automatic intake is allowed, containing only handle/expiry/instructions. It respects Stop and current work; the internal receipt envelope is hidden from conversation rendering. No submitted field/image is included. Secure tools bypass ordinary manager journals; application tool-event outputs are withheld and native artifact indexing excludes this tool even for explicit model reads. Explicit reads necessarily enter native/model history and cannot be erased by deleting this transfer.

Received transfers expire one hour after receipt (timer plus access-time checks); Delete Now and bot deletion share one lifecycle. Pending keys expire after one hour and partial transfers after 60 seconds of inactivity. Restart marks waiting/received metadata unavailable; fresh submissions require a new request. Mutable byte buffers are wiped and references dropped best effort, without a forensic-erasure promise. Browser open-form bytes are not persisted for offline recovery.

## V1 bounds and compatibility

Six fields (4096 characters each), two PNG/JPEG/WebP slots, 20 MiB cumulative image bytes; signature/MIME checks, no thumbnails or gallery. Ciphertext <=29 MiB, chunk <=192 KiB. Volatile capacity: 32 requests, eight outstanding per bot, four partial transfers/64 MiB, 64 MiB image bytes, 256 bounded use IDs (desktop32) plus256 release IDs per receipt, 16 retained responses per receipt (1 MiB each / 64 MiB globally). Oversized responses are withheld. Desktop printable ASCII 1–1000 characters and existing recent-observation/window/control-lease checks remain; queued input rechecks receipt validity before dispatch. HTTPS accepts only the declared exact origin, normal certificate validation and no redirects. Responses/status/errors never return content except explicit human-approved model-read.

No D1/S3/schema/credential changes. Ordinary S3 uploads, drafts, rich clipboard, replies, burst and queue behavior stay separate. Old bridges omit `secureInputs:1`, so the new UI does not offer the feature. Old clients ignore metadata. No sensitive fallback is allowed.

## Activation and rollback

Dwight owns integration and release: deploy the existing Wrangler bots relay first, publish frontend/SW68, then activate the exact bridge source/tools at strict idle. Do not restart active bots. No new credential or access scope is required. Rollback only after idle: the old bridge loses volatile data; show unavailable metadata and request a fresh form. Never replay a private payload via ordinary paths.

Synthetic checks cover crypto/scope/tampering/size/retries/expiry/deletion/restart/private desktop+HTTPS adapters/MCP+dynamic routes, ordinary journal/catalog scans and real Chromium WebCrypto/React/native IndexedDB cards. Production relay/session routing, private live API/desktop entry, actual Codex tool discovery/model opt-in and physical Safari/touch require activation evidence; source/build checks do not claim those verified.

## Polling and response lifecycle

Use `bots_use_secure_input` with `mode: "status"` for scoped metadata, remaining use IDs and retained response IDs. Request IDs, transfer IDs and original operation fingerprints remain bound to the caller's bot/thread. The credential still expires after one hour; neither polling nor releasing responses renews it. There are 256 finite HTTPS/use operation IDs per transfer (desktop at most32), plus at most256 response-release IDs. This accommodates three jobs polled once per minute for a one-hour lifetime (180 reads), with a bounded margin; it is not an unlimited polling service. Use slow, meaningful status checks and honor cancellation/Stop.

After an explicitly permitted `model-read` of a response, release it explicitly with `mode: "release-response", responseId, operationId`. Private mode can release without granting model access. Unread bodies are never silently evicted. Release zeroes a body buffer and retains the live credential, response tombstone, original method/input fingerprint and operation receipt. A repeated committed or uncertain operation returns its original receipt; a released response is reported as released and HTTP is never sent again. Expiry, deletion and restart remain unavailable, not instructions to replay a mutation.

At most16 bodies per transfer, 1MiB each and64MiB globally are retained. In-flight reads reserve a slot and1MiB of global capacity before HTTP starts. A `blocked` / `capacity-before-request` receipt positively means HTTP did not start; explicitly release consumed responses, then retry only the SAME unchanged operation ID. All other used/unknown outcomes remain immutable. Successful HTTP with an oversized body is `used` / `too-large-withheld`; it must never be treated as a failed mutation to resend. Reads and cancellations settle within the existing30-second request deadline.

The private HTTPS transport supports bounded UTF-8 textual responses for opted-in model reading. Binary bodies remain private until explicit release/expiry and cannot be published or downloaded through this tool. PNG/Blender delivery needs a separately reviewed scoped registered-file adapter; no caller-selected filesystem path or token-bearing normal upload is supported. Never write secrets or private response bytes to logs, app history, scripts, profiles, ordinary files or artifacts.

Waiting forms have an independent **Open private form** affordance. It does not jump or alter the native history window. Completed/expired form descriptions keep their chronological history scope. Offline forms retain their open encrypted submission for same-ID retry; account/bot/thread changes dispose the form. Form metadata read errors expose **Retry forms**, without making another request or inventing a form.
