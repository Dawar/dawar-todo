# DawarTodo performance baseline — 24bf969

Measured 2026-09-26 on unchanged `24bf96976393d37b3ffea6c5be94fb43ce797af3` (site v134 context). **Chat rendering, repeated history hydration, and persistence are the leading measured problems.** This is a measurement/design handoff, with no production fixes or claimed before/after gain. Raw results: [perf-baseline-7c578085.results.json](perf-baseline-7c578085.results.json).

## Reproduce and compare

From the repository root, with the existing package-lock dependencies available:

```sh
mkdir -p outputs
node tests/perf-baseline-7c578085.mjs > outputs/perf-current.json
node tests/perf-baseline-7c578085.mjs --no-browser > outputs/perf-current-node.json
node tests/perf-native-history-7c578085.mjs > outputs/perf-current-native.json
node --test tests/fluid-sync.test.mjs tests/sync-resilience.test.mjs bot-bridge/browser-state.test.mjs bot-bridge/runtime.test.mjs
```

The first command is the integrated-change comparison command. Apply this benchmark-only commit to the integrated branch, then run it unchanged. Compare named scenarios/counts with the checked-in JSON, followed by timings on the same host/browser. `PERF_CHROME` selects a Chrome binary (default `/usr/bin/google-chrome`); the optional native probe accepts `PERF_CODEX` and requires Linux `bwrap`. No new dependencies were installed: this worktree reused the existing repository `node_modules` through an ignored symlink. `esbuild` is already in the lockfile. No app server/build, account, production API, user profile, or private fixture is required. The fresh browser profile and temporary native fixture are deleted after each run.

New code lives only in four `tests/perf-*-7c578085.*` files; existing helpers and production files remain unchanged. The task filter adapter finds actual `useMemo` callbacks through TypeScript AST; row/message instrumentation is applied to an in-memory bundle. If a refactor moves those functions, the adapter fails explicitly and needs relocation, not a substitute implementation. The full Bots workspace is mounted with its real effects, markdown, reducers, client event handling, and cache helpers; only RPC/session/download boundaries and the unrelated site header are synthetic.

## Data and limits

- Host: Linux x64 `DO-Premium-AMD`, Node 24.21.0, Chrome 154.0.8037.57 headless, production React 19.2.6, 1280×900, no CPU throttle. **These are not iPhone measurements.** No server/D1 latency, battery energy, compressed wire bytes, or Codex-app comparison was measured.
- Sync: real `task-sync.ts`, `task-store.ts`, `sync-health.ts`, and worker `revisionEventStream`; deterministic 300-second clock, 195 ms per synthetic HTTP/SSE handshake, 289 synthetic tasks/10 projects. Queue/storage methods are counted asynchronous stubs here. Worker revision reads call an in-memory stub, not D1. The real worker's ~56-second lifetime and heartbeat loop are included. App-timer counts exclude fixture transport/worker timers.
- Storage costs: real `offline-store.ts` using the existing fresh fake IndexedDB helper, 5 warmups/30 samples; timings include instrumentation and memory cloning, **not browser IndexedDB/disk latency**. Real Chrome localStorage is measured separately.
- Chat: latest page has 20 turns, matching `runtime.historyPage`; small = 20 markdown messages/31,028 JSON bytes; dense = 400 markdown messages/569,128 bytes; accumulated = 400 cached short turns followed by a real workspace replacement with a 20-turn response; tools = one of the 20 turns contains 80 × ~32 KiB tool outputs, plus 3 image references inside a closed scheduled turn (2,907,312 JSON bytes). Synthetic SVG download stubs count requests without remote data.
- Weak link is an RPC promise delay of 600 ms + serialized response bytes / 128 KiB/s; this is **not packet-level network emulation**. Other RPCs use 195 ms. Bytes exclude transport envelopes, compression and chunk/base64 overhead. Navigation figures are individual scenario observations; stream figures use 10 separately committed updates with at least 50 ms between them. Forced `flushSync` defines a reproducible unbatched event bound; it does not establish the exact batching rate of a real socket.
- Offline chat is a connection-disabled workspace navigation in the same fresh browser session, not a browser-kill/restart durability test. Task rows use real components but no built Tailwind stylesheet or complete Home page. Task mount/update costs include row layout effects; 289 rows have 3 samples, 2,890 rows only 1 expensive sample. Reported large-list timing is diagnostic, not a stable p95.
- SW: real worker in a fresh localhost browser, instrumented native Cache/Response APIs; synthetic 32-asset graph/9 shell resources, not the deployed asset bundle. Update changes two asset URLs and increments the cache generation in the served test copy. Offline fallback additionally makes the local server close connections because page CDP offline mode alone does not block service-worker fetches.

## Measured chat results

| Fixture | First latest-message paint | Repeat cached opening | Offline cached opening | Full JSON returned on every online opening | 10 stream events: message renders / median synchronous update |
|---|---:|---:|---:|---:|---:|
| 20 short turns | 367 ms | 166 ms | 160 ms | 31,028 B | 200 / 61.4 ms |
| 20 dense turns, weak link | 6,901 ms | 2,928 ms | 2,046 ms | 569,128 B | 4,000 / 897.1 ms |
| Cached 400 short turns | 1,250 ms | 125 ms after replacement | 135 ms after replacement | 31,028 B | 200 / 50.5 ms after replacement |
| One turn with 80 tool outputs | 392 ms (fast synthetic link) | 205 ms | 126 ms | 2,907,312 B | 1,010 / 82.2 ms |

These are **page** fetches, not necessarily complete native-thread fetches. The initial bridge already uses `limit:20, itemsView:"full"`; turn count does not bound items, output size, or DOM. Dense cached opening remains slow without network dependency: mounting/parsing all message markdown is itself expensive. Streaming uses `BotsClient.receive`, so snapshot notifications and workspace effects are included. All final synthetic deltas remained visible.

Concrete evidence:

- Each navigation sequence A→B→A→B→A plus reconnect made **6 history requests**, each returning the same full latest page; reconnect alone added one. `loadHistory` always calls `rpc("history")` when online. There is no measured delta/resume optimization in this path.
- In A→B→A **before replies**, 3 history RPCs remained outstanding, including 2 for A. Resolving newer A before older A made **older A overwrite newer A**. Checking only `selectedRef.current === id` is insufficient; request generation/cancellation is needed even if different-bot responses are ignored.
- The 400-turn cache painted 400 rows, then the fetched page replaced it with **20 rows**. Faster later repeat/offline numbers for this fixture are not an architectural improvement: the displayed/cache working set shrank. Native older history is still reachable online via pagination, but cached completeness/cursors are not recorded.
- Dense streaming invoked every one of the 400 `BotMessage` bodies on every event. No memo boundary prevents repeated markdown parsing for unchanged messages (`workspace.tsx` turn map and inline download callbacks; `message.tsx` ReactMarkdown construction).
- The 80-tool fixture mounted **80 `<pre>` bodies inside closed work logs**, 2 message bodies inside the closed scheduled turn, and initiated **3 attachment downloads while it was closed**. Offline reopening attempted the same 3 downloads. CSS `<details>` closure does not make React children lazy; `AttachmentImage` downloads on mount without a visible/open or offline gate.
- Every 10-event stream performed **20 localStorage writes**: history plus snapshot per event. Total characters passed to storage: 384,411 small; 5,765,411 dense; **29,147,251 tools**. These are API write volumes, not physical disk bytes.
- Latest-message opening reached bottom (0 px gap). Streaming while reading older content preserved the measured position; prepending older messages shifted the tracked anchor only **−0.30 px** in this Chrome fixture. This positive result relies on browser anchoring; it does not verify iOS, late images, or virtualized layouts.
- Navigation away/back did **not restore reading position**: dense scrollTop 36,888 became 103,988 (bottom); small 4,016 became 5,372. There is no separately measured dedicated jump-to-latest control. Add an explicit anchor/bottom-state contract before windowing.

Bot sidebar scaling (no selected thread, real workspace): 20 / 200 / 1,000 bots mounted **20 / 200 / 1,000 DOM rows**. Mount-to-paint was **40 / 99 / 470 ms**; an unrelated client notification took **3.4 / 18.6 / 94.5 ms**. Filtering, dates, configuration labels and all row elements are rebuilt during workspace updates. No claim about a server bot-list query is made.

Direct `BotsClient.save` stress isolates persistence from rendering: 120 calls each appending 32 characters through the real reducer (3,840 new characters total):

| Prior history | Final serialized size | Total characters written | Median / p95 save | Total save CPU/wall slice |
|---|---:|---:|---:|---:|
| 4 turns (~10 KiB/message) | 45,633 chars | 5,247,480 | 0.2 / 0.3 ms | 23.1 ms |
| 400 turns (~10 KiB/message) | 4,181,649 chars | 501,569,400 | 29.0 / 32.3 ms | 3,503.7 ms |

Long-history `JSON.stringify` alone: median **12.2 ms**, p95 13.6 ms; native `setItem`: median **15.3 ms**, p95 17.0 ms. This stress invokes save directly; the separate workspace stream scenario measures actual effect frequency. Three separate large-history saves retained only **1 history**, with **2 swallowed quota failures**. Synthetic owner B could not read owner A's keyed history; `clearOwnerCache()` removed **both owners' entries (2→0)**. These tests do not certify account transitions: `start()` paints last-owner snapshot before session authentication (source-derived risk).

## Native summary semantics — deliberately limited result

The optional executable probe runs installed Codex **0.157.0** in `bwrap` with an isolated replacement home, read-only outside files, and no network. It loads a synthetic rollout, starts **no model turn**, executes no tool command, and deletes its storage. This version differs from the bridge's 0.156.1 compatibility context.

For the one hydrated synthetic turn, `summary` returned the complete **15,000-character user text and 20,000-character assistant text**, as did `full`; `notLoaded` omitted items. But the command item **failed to hydrate in full as well as summary** (`preservesTool:false` in both). Consequently **the tool comparison is inconclusive**. Do not interpret these results as summary removing tool output, a general guarantee of full message preservation, or a payload-reduction benchmark. The script explicitly reports `toolComparisonConclusive:false`.

Official [app-server documentation](https://learn.chatgpt.com/docs/app-server#list-thread-turns) distinguishes omitted/summarized/full item views and documents experimental item pagination; it does not establish all summary field semantics. Before choosing native summary as the UI contract, capture representative native `summary/full` pairs for user/assistant text, commands, diffs, reasoning, attachments and active turns. In the meantime, an application-controlled summary with explicit completeness and on-demand authoritative detail is a safer implementation option than assuming native summaries contain everything.

## Measured sync and storage baseline

Each row is 300 simulated seconds; HTTP count includes bootstrap. SSE opens are separate requests. Active healthy emits revision hints every 5 seconds; active fallback returns a changed task on every response, not arbitrary mouse/touch activity.

| Scenario | HTTP reads | SSE opens | App timer callbacks | Cache loads | Upload scans |
|---|---:|---:|---:|---:|---:|
| Healthy idle | 17 | 6 | 17 | 53 | 71 |
| Healthy revision every 5 s | 68 | 6 | 68 | 206 | 275 |
| No realtime, idle | 37 | 0 | 37 | 113 | 151 |
| No realtime, active deltas | 94 | 0 | 94 | 284 | 379 |
| Realtime lost at 60 s | 42 | 13 | 42 | 128 | 171 |
| Lifecycle event storms | 19 | 6 | 19 | 61 | 83 |
| Hidden 60–240 s, offline/online while hidden | 10 | 4 | 11 | 34 | 47 |
| One upload deferred indefinitely | 17 | 6 | 161 | 197 | 359 |

Raw JSON is authoritative for timer totals and request timestamps. Healthy worker execution performed **149 revision-read calls** in five minutes against a stub: SSE reduces browser polling but still polls the backend revision source. This is not a measurement of D1 query cost.

Healthy idle still reads at t=0, 3.195 s, 33.390 s, 56.490 s, 59.685 s…: reconnect closes health, catches up, and schedules a short fallback before the new heartbeat. An indefinitely blocked upload adds **144 two-second wakeups**, **144 cache loads**, **288 upload scans**, and **0 attempted uploads**. `wakeUploads` reschedules on `snapshot.uploads` even when `nextAttemptAt=Infinity`. The hidden blocked case fires 56 two-second callbacks while visible and none of these cause hidden network activity.

Duplicate `start()` did not duplicate listeners/network. Two bursts each containing 60 lifecycle notifications (second burst during a request) resulted in **2 HTTP reads in the burst's one-second window**, not 120. Maximum concurrent task requests stayed **1** in all scenarios. Hidden/offline requests and timers after `stop()` were **0**. Resume made **1** immediate catch-up read. A stop/restart scenario also completed with no residual timer. These are positive lifecycle protections; no broad timer leak was demonstrated. They do not cover every auxiliary chat lane or multi-tab lock race (the existing two-tab test passed).

Real empty-delta `commitRemoteTasks` under fake IndexedDB:

| Tasks | Median / p95 commit | Serialization calls / characters per commit | Unchanged `setAll` median |
|---|---:|---:|---:|
| 289 | 3.43 / 4.01 ms | 578 / 400,130 | 1.13 ms |
| 2,890 | 33.43 / 46.35 ms | 5,780 / 4,018,708 | 13.65 ms |

Each empty commit did five `getAll` operations and one metadata `put`, with **zero task-row puts**. Source: `offline-store.ts:commitRemoteTasks` loads all tasks, builds maps and JSON-compares every old/new row. Sync then reloads before/after read and through its upload lane. This is O(all cached tasks) work even on a no-op delta. The base task database has one origin-wide fixed name and no owner namespace or explicit row/byte eviction bound (code-derived; not a measured cross-account leak).

Task React isolation is already useful: 30 unchanged store reloads emitted **0 list/row notifications**; 50 draft edits emitted **50 edited-row notifications and 0 list notifications**. Browser filtering median: **0.2 / 1.7 ms** at 289 / 2,890; search **0.2 / 2.3 ms**. These are not the dominant measured expense.

Real task-row browser mount: **463 ms** (289, n=3) / **11,987 ms** (2,890, n=1). Stable parent redraw: **0.7 / 4.6 ms**, **0 row renders**. Advancing the `now` prop by a minute: **77 / 640 ms**, **all rows rerendered**. One draft: **1.8 / 7.7 ms**, **one row rendered**. `TaskRow.resizeTitle()` writes height and reads `scrollHeight` in every row's layout effect; repeated layout is a plausible explanation for superlinear mount cost, not isolated by a layout trace here. The page's minute clock invalidates time-dependent filters/rows; empty-query filtering still builds searchable strings for every task. Prioritize mounted-row/layout work before micro-optimizing filtering.

## Service-worker measurements

- Cold install: **42 server requests** (includes SW script), **32 graph assets fetched**, **41 cache puts**, ~733 ms on the local fixture.
- Cached/repeat navigation: **0 graph downloads**, 1 background document request plus favicon, **34 cache puts**, **33 response text reads**, **146,788 text characters scanned** each time. The 32 immutable assets are reused from cache but still cloned/read/traversed/put. This is redundant local work, not an observed repeated network graph download.
- Cached-shell responseStart observed **3.8 / 3.7 ms** with a 195 ms delayed network document. These are lightweight synthetic-shell timings, not time-to-interactive. Same-path navigation polling and SW startup make the timing diagnostic rather than a strict regression gate.
- Update: only **2 changed graph assets fetched**, **41 puts**; caches **v31 and v32** remain. Retaining two generations is expected and beneficial; do not “fix” it by deleting the previous shell prematurely.
- Failed-network startup returned the cached v32 document, **0 server responses** (4 connection attempts), observed responseStart ~396 ms. This does not reproduce iOS process eviction or prove an offline startup latency bound.

## Prioritized implementation contracts and targets

Targets below are **proposed acceptance budgets**, not achieved gains. Rerun identical fixtures after each integrated pass; preserve native history and live-delta correctness.

1. **P0 — cache-first chat navigation and request ordering.** One in-flight history read per owner/thread/view, deduplicate repeated opens, cancel superseded work where transport permits, and reject every obsolete generation even in A→B→A. Target stale overwrite **false**, ≤1 in-flight request per same thread, no repeat full page when cached cursor/revision is current. Paint useful cached latest content in **≤200 ms** on this fixture host, independent of connectivity, including a fresh offline process test in the next pass. Keep loading/error status from destroying useful cached content.
2. **P0 — bound useful messages/items, not just turns.** Preserve full user/assistant text in a durable latest-message view with explicit `itemsView`, loaded item ranges, continuation cursors, revision, and completeness. A huge tool turn must not prevent the latest answer from becoming durable. Target initial latest-view payload **≤128 KiB when the visible message itself fits**, a bounded DOM window (initial target ≤100 message bodies), and **0 closed tool-body/attachment mounts**. A 20-turn response can still be multi-megabyte; use native item pagination where supported or an explicit application projection plus on-demand native full detail. Never silently truncate an answer, delete old native data, or treat a partial cache as a complete conversation. Oversized visible answers need explicit continuation and complete retrieval. Older history, tools, search results, and scheduled runs must remain accessible through pagination/detail hydration.
3. **P1 — streaming and persistence proportional to changes.** Stable item identity, item-level memo/subscriptions and stable callbacks; coalesce socket deltas to animation frames while preserving ordered text and authoritative item completion. Target unchanged message-body renders **0 per delta**, ≤1 affected visible body/update, synchronous update **<16 ms median, <50 ms p95** on dense fixture. Incremental IDB records for changed items/turn metadata; coalesce writes (initial ≤4 transactions/s plus a final durable flush), with no full-history localStorage write or pruning `getAll` per token. Keep pending drafts/outbox separate from disposable history eviction. Validate all final deltas and hidden/close/reload recovery.
4. **P1 — reading-position and sidebar scaling.** Persist `(thread, anchorItemId, offset, followingLatest)`; explicit bottom jump should restore latest in ≤100 ms from a warm bounded view. Restore older reading position within **2 px** in deterministic fixed-content tests, including prepend and delayed images; test iOS separately. Window large bot lists and memoize row metadata; target ≤100 mounted sidebar rows for 1,000 bots and unrelated redraw **<16 ms**. Avoid remounting all history when switching tabs or reconnecting.
5. **P2 — sync lifecycle/idle work.** Eliminate timers for indefinitely blocked uploads; target **0 periodic blocked-only wakeups**, wake on explicit retry/cancel/change, and schedule finite retry at its deadline. Preserve zero hidden/offline HTTP calls and one writer. After healthy stream establishment/reconnect, replace provisional short fallback with the healthy schedule: target **≤12 idle HTTP reads/5 min** with this worker lifetime. Preserve immediate revision catch-up and safe fallback on loss. Empty unchanged delta should serialize **0 task rows**, no task `getAll` when metadata alone suffices, and ≤1 necessary store reconciliation; target <2 ms synthetic commit at 289 and no linear row work at 2,890. Do not weaken pending-mutation reconciliation to meet this budget.
6. **P2 — task rows and SW local work.** Bound large mounted task lists; avoid layout effects for unchanged/noneditable row titles and avoid blanket clock invalidation where due state is unchanged. Keep the already-correct one-row draft behavior. On warm shell refresh, target **0 immutable graph puts and 0 unchanged graph text reads** while still atomically making new documents' assets available; keep previous generation and cold-install completeness. Chat work has higher measured user impact than this SW optimization.

## Incoming draft/cache boundary (not part of these measurements)

Read-only inspection of worker `3816777c…`'s `history-cache.ts` confirmed the proposed 1 MiB entry cap, 6 stored entries, 100-turn tail, owner/bot composite key, post-commit legacy removal, and `getAll()` pruning. Manager reports a 4-entry memory map/cached-first load. **None of that code is in this measured base.** Do not label migration to IDB alone as completion of this performance pass.

The incoming bounded-history routine traverses attachment metadata plus newest full turns to estimate size. If the latest turn alone exceeds the cap, it returns null and can leave old persisted history stale. Pruning clones all history values. Follow-on design should store small indexed eviction metadata separately, preserve explicit cache completeness/cursors, and build a useful latest-message projection even for tool-heavy turns. Add integrated probes for 8 histories, owner changes, cache eviction, oversized newest turn, pending async writes at navigation, and browser restart offline. Keep drafts worker ownership intact until integration; this branch changes none of its files.

## Verification and remaining limits

Completed: full baseline runner (including browser assertions), node-only deterministic runner, optional native probe (message hydration checked; tool result explicitly inconclusive), three Node syntax checks, scoped ESLint, and **42/42 existing tests** from the four named test files. The browser runner verifies final stored stress deltas, owner-key isolation, two shell generations, offline cached shell, and no unexpected JS exceptions. Baseline defect scenarios report observations rather than asserting defects must remain.

No production build/full test suite, actual Cloudflare/D1 load test, iPhone/WebKit trace, native tool-summary equivalence, server full-history throughput, physical storage durability, or battery measurement was performed. Attachments are tiny synthetic stubs. A supported local Chrome harness exists and was used; large-list mount samples are intentionally limited due cost. Before claiming the goal achieved, measure integrated before/after with the same fixtures and then validate the target iPhone's cached opening, active stream, background/resume, and offline restart with authorized diagnostics.
