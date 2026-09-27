# Bot chat and artifact product design

UI base: live `a5f68a9`. Core UI checkpoint: `847153a`. Reviewed artifact backend `004339ef` and timestamp correction `a59d9baf` are incorporated as equivalent local commits `3c8f994` / `0a42904`. No Task, upload API, SW or database-version changes were made by this UI work. Integrate the UI commits onto manager main `1216bbc` so v137 / SW34 remain intact. Nothing was published or restarted.

## Product behavior

The supplied phone screenshots were inspected, then the actual React UI was rendered and iterated at 320, 390 and 1440 px. The green/neutral treatment uses quieter surfaces, readable message rhythm, compact work disclosures, clear focus states and touch controls. Model controls, drafts, staged bytes, queues, stable send IDs and uncertainty recovery keep their existing behavior.

- **Composer:** value/layout measurement before paint; empty placeholder never controls height. Restoring, clearing, sending, switching bots, Activity hide/show, font/width and visual-viewport changes remeasure without a tap. Routine save labels occupy no space; actual persistence is immediate. A genuinely slow save is visible after two seconds; storage/transfer/conflict/uncertain-send failures remain recoverable.
- **Conversation:** floating latest control only when meaningfully away, hidden at bottom/short threads. Streaming, tool expansion and late images preserve follow-latest. Correct `1 step` / `2 steps` work labels. The global file dump is removed from the conversation tail.
- **Attachments / Artifacts:** bot settings has an icon, label and count entry. The Bots sidebar has the global Artifacts destination (`?view=artifacts`), avoiding another crowded mobile tab. Both use month-descending grids, filename/type/size/date, bot attribution/filter, filename search and type filtering. Unknown dates remain **Date unknown**. The API has no total count, so `36+` honestly means a loaded lower bound, not a claimed complete inventory.
- **Delivery:** visible/near-visible image and PDF thumbnails use the real backend renderer. Originals load only after Open/Download. Image zoom, full PDF iframe plus native Open PDF, downloads, Escape/focus return, fallback cards and offline saved previews are implemented. Original download filenames come from the authoritative chunk response. Explicit `bot-artifact:` Markdown links become message-local cards; the sanitizer permits only this additional application scheme. Duplicate work-log cards are suppressed when the same file is linked by a visible reply.
- **Quota:** remaining fill starts at 100%; 12% used shows 88% remaining, including meter accessibility values. Local reset date and days/hours/minutes-left update every 15 seconds while mounted; expired/missing times are explicit.

## Bounds and lifecycle

Gallery pages contain at most 36 cards. The native list RPC reads SQLite metadata; no history/file scan precedes listing. First native discovery reads at most one page for each of two bots, reusing recent discovery checkpoints for 60 seconds; older discovery is explicit and continues in bounded batches. Recoverable indexing failures have retry controls. Index completion and attachment events share a coalesced refresh lane. If reading an older page, new files produce a Show latest action rather than replacing that page.

Owner + query identifies page requests; identical requests coalesce and stale filter/owner results cannot overwrite the current view. Thumbnail keys include owner/bot/id/version, with three active client requests maximum. Navigation retains filters, cursors and scroll for the last eight gallery destinations. Native select choices are memoized independently of changing bot status; the existing virtualized bot sidebar remains intact.

Disposable gallery IDB is separate from all critical stores: at most 16 page/progress records / 2 MiB and 48 thumbnails / 8 MiB. Pruning reads small metadata, never all image values. Blob URLs are revoked when their views close. An already-open original remains usable across connection loss without another download. Originals are not stored in this thumbnail cache; offline UI clearly identifies saved previews and the connection requirement for originals. Closing a viewer stops subsequent original chunks; an already-issued RPC can still finish.

## Measured results

These are Linux Chromium 154 synthetic measurements, **not iPhone/Safari timings**. The browser runner uses production components and real native browser IDB. Its local artifact server uses the real BotRuntime, temporary SQLite and synthetic files, actual Sharp/Poppler previews, and real original-chunk reads. No user account/files/messages were accessed.

| Check | Actual result |
|---|---|
| Exact empty-tall reproduction against a5f68a9 | Type long draft then clear without focus: empty input stays **180 px** |
| Current same sequence, 320 / 390 / 1440 | **180 → 40 px**, unfocused; restoration, send-clear, bot switch, Activity and font checks pass |
| Independent release layout gate | No findings; 320/390 widths, multiline recovery and simulated keyboard budget retained |
| Gallery first page | **36** cards; **0** original downloads before opening a file |
| 15 attachment events in one burst | **1** list refresh |
| Gallery leave/return | **400 px** scroll restored; filters/pagination and stale search rejection pass |
| Offline page restart | **36** cached cards and saved preview viewer; **0 RPCs** |
| Real native gallery list responses | **2,806–15,024 bytes** JSON in measured filtered/full pages; SQLite handler **0.9–4.7 ms** in the first recorded integrated run |
| Actual preview responses | **3,310–3,958 bytes** JSON including base64 for these synthetic PNG/PDF files; no unavailable results |
| Existing weak-link chat fixture, warm repeat | **165.9 ms**, unchanged-history response **84 bytes** |
| 400 cached-turn fixture | **166.1 ms** warm; all **400** entries retained, **40** mounted |
| 80-tool turn | **33.1 ms** warm; **0** mounted closed tool bodies / scheduled bodies / attachment downloads |
| Streaming, all existing chat fixtures | **0** unchanged BotMessage renders per delta; no synchronous full-history localStorage writes |
| Existing earlier-page / return anchors | At most **0.5 px** / **0.375 px** offset error |
| Existing 1,000-bot fixture | **20** sidebar rows mounted; **29.1 ms** mount-to-paint |
| Existing fresh-browser-process chat offline fixture | **85.4 ms**, 0 history requests, opened detail available; nine-history retention and cold anchor checks pass |

The chat figures confirm that this product pass retains the prior architecture's gains; they are not newly attributed to styling. Timings vary with host load. Gallery offline testing above is a fresh page/JS context in the same browser profile; the separate chat harness performs a browser-process restart. PDF embedding/native keyboard behavior still requires manager's real-device release review.

## Verification and reproduction

Current focused checks: 49 composer/cross-tab/timeline/gallery tests; 19 native artifact/old-relay tests including actual image/PDF rendering and original bytes. TypeScript, new-module ESLint, production build, independent release browser and existing workspace offline bytes/history browser checks pass. Design runner covers populated, empty, loading, offline, error, recovery, keyboard, viewer, navigation and indexing retry/continuation. Browser errors: zero in completed runs.

```sh
node tests/bot-design-browser.mjs
BOT_DESIGN_BASE=a5f68a9 node tests/bot-design-browser.mjs
node tests/bot-release-review-browser.mjs
node tests/bot-workspace-browser.mjs
node tests/perf-chat-browser-098e1aae.mjs
node --test tests/bot-product-gallery.test.mjs tests/bot-composer-durability.test.mjs tests/bot-composer-cross-tab-review.test.mjs tests/bot-timeline-098e1aae.test.mjs
node --test bot-bridge/artifacts.test.mjs tests/bot-artifact-old-relay.test.mjs
npx tsc --noEmit
npm run build
```

The native PDF renderer requires the provisioned Poppler executable (see `BOT_ARTIFACT_API.md`). The runner only starts disposable localhost fixture servers/browser profiles; it does not connect to live native services.

Screenshots and JSON: `outputs/bot-design/` and `outputs/bot-design-before/`. Review `chat-390.png`, `chat-1440.png`, `empty-height-reproduction-390.png`, `keyboard-320.png`, `recovery-390.png`, `gallery-populated-390.png`, `attachments-320.png`, `gallery-populated-1440.png`, `viewer-pdf-320.png`, `gallery-offline-cached-320.png`, `gallery-error-390.png`, `message-outputs-390.png`, and `settings-quota-390.png`. Loading/empty/offline/error views exist at each width. Measurements/logs are under `outputs/bot-design-*`, `outputs/bot-gallery-*`, and `outputs/perf-chat-partial-098e1aae.json`.

## Coordinated integration gate

The gallery is connected to the reviewed real API. Message-local UI is implemented and tested with registered metadata, but the backend-owned `history.view` / `history.detail` currently return attachments for user image paths only. Reloaded assistant `bot-artifact:` references and native output-item provenance need a bounded metadata lookup in those responses. This was reported to the manager for the native specialist; no concurrent backend source edit was made. Explicit links still open authoritative originals without metadata, but full message-local thumbnail fidelity after reload must not be claimed until that adapter is integrated and checked. The message-output visual fixture supplies registered metadata from `artifacts.list` to isolate the UI contract and does not pretend that missing history wiring is already present.

Manager visual review and physical iPhone/Safari verification remain release gates. No deployment/restart was performed.
