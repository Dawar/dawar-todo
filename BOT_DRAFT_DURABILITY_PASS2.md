# Bot composer durability pass 2

Review branch: `codex/durable-bot-composer-drafts-and-attachments-3816777c`.
Base: `24bf969` (site v134). No merge, push, deployment, service restart, schedule change, or live-account mutation was performed.

## Change and ownership

- `app/bots/draft-store.ts` owns the critical IndexedDB database `dawar-bot-drafts`. Per-owner/per-bot records contain normal drafts, separate queue edits, recoverable cross-tab text versions, and frozen submitted operations. File bytes live in a separate object store; typing does not rewrite bytes or serialize histories.
- `composer-controller.ts`, `composer-service.ts`, `use-composer.ts`, and `composer-state.tsx` own immediate input capture, transaction-completion status, staged files/previews/removal, retries, lifecycle flushing, cross-tab notifications, and scoped asynchronous completion. Service-owned controllers survive React Activity teardown. Composer opening does not wait for history or a network request.
- Acknowledgement checks the submitted text revision and local attachment IDs atomically. Newer typing/files and another bot/owner/queue slot are preserved. Unsubmitted drafts never become sends on reconnect. An uncertain submission retains its original operation ID and frozen parameters through reload and retry.
- Uploaded bytes are committed before transfer begins. Normal upload retries use stable begin/chunk/finish IDs. An explicit **Restart failed transfers** action can create a fresh upload attempt if the server lost an incomplete upload checkpoint, while retaining the same local file and bytes. It never sends a message. Incomplete server uploads may remain as unreferenced server files; this pass does not delete server files.
- Legacy `draft:*`, `uploads:*`, and relevant `operations` localStorage entries migrate with a committed marker. Originals remain intact. A migration failure blocks editing the unrecovered record and exposes recovery controls. Legacy uploaded attachments have references but no local bytes; their offline-copy limitation remains visible until download succeeds.
- `client.ts` restores an established local owner for cached/offline access. Explicit sign-out, an auth denial (including malformed error bodies), and a confirmed owner change detach the connection, mask old-owner state and reject old pending requests as uncertain without deleting owned drafts. Late socket callbacks cannot become the next owner's state.
- `workspace.tsx` is smaller. History and queue reads use owner/bot/request-generation guards; history callbacks have no composer writes. The existing mobile viewport behavior remains in place.

No changes were made to task `offline-store.ts`, `task-sync.ts`, `sync-diagnostics.ts`, or task `page.tsx`.

## Necessary send-outcome protocol

The manager authorized the narrow changes in `bot-bridge/runtime.mjs`, `response.mjs`, `service.mjs`, `bots-relay/src/index.ts`, and `lib/bots-types.ts`.

For `turn.send`, `queue.add`, and `queue.update`, runtime certainty is tracked at the actual native mutation call. Proven pre-call failure or an explicit native JSON-RPC rejection returns `outcome: rejected`. A transport error, malformed native return, or local/storage exception after the call remains uncertain. An old stored `failed` label is not sufficient evidence of rejection. The relay forwards the outcome; missing/unknown outcomes are treated conservatively by the browser. Malformed success payloads do not clear composer sends.

Release must coordinate the site, relay, and bridge changes. With an older bridge/relay, safety is preserved but definitive server rejections can remain unconfirmed in the composer until the outcome protocol is available. No service was restarted by this worker.

A lost acknowledgement for `queue.update` can remain unresolved: the native queue API does not give that update a client operation ID that the current bridge can conclusively reconcile after an ambiguous commit. The original operation and edited draft are retained; the client does not manufacture a new ID or repeat the native update. This limitation is explicitly covered by a test and is not reported as success.

## History/performance handoff

`app/bots/history-cache.ts` is the disposable boundary for the performance worker. It uses a separate database (`dawar-bot-history-cache`), up to six snapshots, at most 100 recent turns and an estimated 1 MiB per entry. It preserves legacy fallback until a usable replacement commits. If the newest turn cannot fit, it retains the last useful cache rather than replacing/deleting it. Truncated/stale offline copies are labelled in the UI. Streaming updates are coalesced and flushed on navigation/background events so the latest cached delta is retained.

The performance worker can replace `readBotHistory`, `queueBotHistory`, `saveBotHistory`, and the timeline hydration/rendering without touching draft storage. Keep composer recovery independent; keep owner/bot/generation checks on history callbacks. Runtime overlap is limited to history methods versus this pass's operation handling and `send`/`startTurn`/queue mutation call boundaries.

## Verification actually run

- `node --test tests/bot-composer-durability.test.mjs tests/bot-client-recovery.test.mjs`: 28 passing focused tests. Covers migration abort/corrupt data, commit completion, atomic bytes+metadata rollback, upload failure/restart, offline recovery, limits, simultaneous tabs, same-text newer revisions, queue editing, late send/upload completion, owner changes, operation-save/acknowledgement-save failures, malformed response/parser paths through the real `BotsClient`, and preservation of the last useful oversized-history cache.
- `npm run bots:test`: 45 passing bridge/browser-state/relay/manager tests, including actual runtime → service response helper → client → durable composer tests. Tests prove corrected retry after definite rejection, same-ID reconciliation after native commit plus EPIPE/malformed return/local exception, conservative legacy failed-operation handling, and queue mutation outcome behavior.
- `node tests/bot-workspace-browser.mjs`: real production React workspace in Headless Chrome 154 on Linux, native IndexedDB and file/object URL APIs, fresh temporary profile, synthetic transport. Passed A → B → A overlapping history requests, typing during history refresh, late send acknowledgement after selecting B, React Activity hide/show navigation, actual browser back, offline attachment staging/removal/previews, text+byte recovery after a full page navigation/reload, and offline history including the final stream delta. No browser exceptions were observed.
- `npx tsc --noEmit`: passed.
- `npm run build`: passed.
- `npm run bots:check`: passed TypeScript and Wrangler relay **dry run**; no deployment.
- Targeted ESLint on changed production modules: no errors; two warnings in untouched existing runtime/relay lines (unused `received`, anonymous default export).
- `node --check bot-bridge/service.mjs` and `node --check bot-bridge/response.mjs`: passed.
- `git diff --check`: passed.

## Verification limits

Actual iPhone Safari / installed iPhone PWA behavior was **not tested**. No claim is made about iOS keyboard/background suspension, OS termination timing, quota eviction, or device reboot. Browser tests simulated the offline bot transport and exercised reload against the local test server; they did not test a full network-offline service-worker shell launch or the live VM. Unit transaction faults use fake-indexeddb; browser tests use real Chromium IndexedDB. Cross-tab concurrency is fault-tested with independent controllers sharing the store; the real-browser harness is single-tab.

Writes start on input and only show saved after IndexedDB transaction completion. A browser/OS kill before that completion cannot be guaranteed recoverable. Pending/failed writes remain visibly unsaved, retain their in-memory data, retry on lifecycle events, and request a beforeunload prompt where supported. Native iPhone acceptance and coordinated release remain the manager's follow-up work.
