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

Six fields (4096 characters each), two PNG/JPEG/WebP slots, 20 MiB cumulative image bytes; signature/MIME checks, no thumbnails or gallery. Ciphertext <=29 MiB, chunk <=192 KiB. Volatile capacity: 32 requests, eight outstanding per bot, four partial transfers/64 MiB, 64 MiB image bytes, 32 private-use operations per receipt, 16 responses per receipt (1 MiB each / 64 MiB globally). Oversized responses are withheld. Desktop printable ASCII 1–1000 characters and existing recent-observation/window/control-lease checks remain; queued input rechecks receipt validity before dispatch. HTTPS accepts only the declared exact origin, normal certificate validation and no redirects. Responses/status/errors never return content except explicit human-approved model-read.

No D1/S3/schema/credential changes. Ordinary S3 uploads, drafts, rich clipboard, replies, burst and queue behavior stay separate. Old bridges omit `secureInputs:1`, so the new UI does not offer the feature. Old clients ignore metadata. No sensitive fallback is allowed.

## Activation and rollback

Dwight owns integration and release: deploy the existing Wrangler bots relay first, publish frontend/SW68, then activate the exact bridge source/tools at strict idle. Do not restart active bots. No new credential or access scope is required. Rollback only after idle: the old bridge loses volatile data; show unavailable metadata and request a fresh form. Never replay a private payload via ordinary paths.

Synthetic checks cover crypto/scope/tampering/size/retries/expiry/deletion/restart/private desktop+HTTPS adapters/MCP+dynamic routes, ordinary journal/catalog scans and real Chromium WebCrypto/React/native IndexedDB cards. Production relay/session routing, private live API/desktop entry, actual Codex tool discovery/model opt-in and physical Safari/touch require activation evidence; source/build checks do not claim those verified.
