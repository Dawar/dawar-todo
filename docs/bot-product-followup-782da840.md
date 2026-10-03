# Bot product integration follow-up

## Honest gallery counts

Later pages label their size explicitly: **Page 3 · 8 files**, rather than implying the entire library contains eight files. A first page with another cursor retains **36+ files**. Complete single-result searches show **1 file**. Month counts on paged views say **6 files on this page**; unknown dates remain in **Date unknown**.

The actual component/browser fixture uses 80 synthetic registered files in temporary native SQLite. At 320, 390 and 1440 pixels, paging through three pages makes exactly two additional list calls, with no inventory enumeration. Last-page size is eight; the unique-name search returns one. No browser exceptions or width overflow. Phone and desktop changed-state screenshots were visually inspected. TypeScript and ESLint for the changed component pass.

```sh
BOT_DESIGN_FOLLOWUP=counts node tests/bot-design-browser.mjs
npx tsc --noEmit
npx eslint app/bots/artifact-gallery.tsx
```

Evidence: `outputs/bot-design-followup/result.json`, `gallery-last-page-{320,390,1440}.png` and `gallery-single-file-{320,390,1440}.png`. Browser is Linux Chromium 154 with emulated sizes, not physical iPhone/Safari verification.

## Real history integration

Incorporated reviewed backend `07471c667af8fe8d2d27442a3d3be4a58a1f8c25` locally as `0cf45b4`. Manager main already contains its equivalent; do not cherry-pick this backend commit again.

The message-output fixture no longer gets metadata from `artifacts.list`. It publishes a synthetic PDF and registers a native `imageGeneration` output using the real native registration functions, then serves synthetic Codex turns through **real `BotRuntime.handle(history.view/history.detail)`**. A fresh browser owner opens history before any gallery. Actual Sharp and Poppler thumbnails and original chunk reads are exercised. This gate failed before backend integration at the missing real-history filename assertion; it now passes at all three viewport sizes.

| Fresh-load check, 320 / 390 / 1440 | Actual result |
|---|---|
| Published PDF + native image | Both metadata cards and actual decoded thumbnails visible |
| First history view | **2,414 bytes** serialized response |
| Detail responses after explicitly opening both work items | **832 / 842 bytes** |
| Closed work detail requests / original downloads | **0 / 0** |
| Gallery metadata requests needed for message cards | **0** |
| Message-local original viewers | PDF iframe and decoded image open successfully |
| Work log/reply duplicate | One card per delivered file; log stays closed until requested |
| Browser exceptions | **0** |

`BotTimeline.detail()` now treats `notModified` as a text-only condition. It combines cached, current and freshly returned attachment metadata, schedules timeline metadata persistence, and updates the opened-detail cache before resolving. The existing metadata object store holds the attachment override keyed by native text version. It does **not** rewrite/serialize the unchanged body, change the DB version, or prune critical storage. Old cache rows still work; a concurrently saved newer body rejects an old metadata update. Owner checks remain in place across the async write.

The real-runtime/controller regression returns **552 bytes** for a conditional response concerning a **54,030-character** answer, with **0 additional native reads** and **0 body writes**. A fresh controller/module instance using the same durable IndexedDB fixture loads the complete answer and updated metadata offline with no network. This is deterministic fake-indexeddb evidence, not a new browser-process-restart claim. Additional checks cover live/replayed attachment metadata without native text hydration, a newer attachment event arriving during the conditional read, different-owner exclusion, concurrent version protection and pre-upgrade rows.

## Final focused verification

**38 tests pass**, plus TypeScript, changed-module ESLint, and the real-component focused browser run. Existing timeline/performance synthetic native helpers now use disposable real SQLite metadata indexes required by the adapter; their content fixtures remain unchanged.

The existing performance browser runner also passes after that necessary helper adaptation: **0 unchanged message renders** per delta in every scenario; **135.3 ms** warm paint with all **400** cached entries retained / **40** mounted; **33.2 ms** for the closed 80-tool turn with **0** tool bodies/downloads; **28.5 ms** for 1,000 bots / **20** rows; **81.8 ms** fresh-browser-process offline paint, **0** requests, opened detail and cold anchor retained after nine histories. Dense weak-link repeat is **132.7 ms**, but its page now contains **37** entries because the backend reserves room for bounded metadata, so this is a compatibility check rather than a new like-for-like performance gain. The older cursor remains available. `performance-compat.json` preserves full results; host timing variation is not attributed to the small UI correction.

```sh
BOT_DESIGN_FOLLOWUP=1 node tests/bot-design-browser.mjs
node tests/perf-chat-browser-098e1aae.mjs
node --test tests/bot-history-metadata-ui.test.mjs tests/bot-timeline-098e1aae.test.mjs tests/bot-product-gallery.test.mjs bot-bridge/history-artifacts.test.mjs bot-bridge/history-view.test.mjs
npx tsc --noEmit
npx eslint app/bots/artifact-gallery.tsx app/bots/timeline-controller.ts app/bots/timeline-detail-cache.ts
```

Changed-state screenshots only: `outputs/bot-design-followup/gallery-last-page-{320,390,1440}.png`, `gallery-single-file-{320,390,1440}.png`, and `message-outputs-{320,390,1440}.png`. Phone/desktop screenshots were personally inspected; accepted spacing, colors and layouts are retained. `result.json` records every real runtime request, response size and native call. The native source is synthetic; no live account or actual iOS verification is claimed. No main integration, Task/SW change, push, deployment, service restart or user-data operation was performed. Manager owns final main integration/release and physical-device validation.
