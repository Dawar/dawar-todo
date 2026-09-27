# Bot chat performance implementation — pass 4

Measured 2026-09-27 against the original `24bf969` baseline in [perf-baseline-7c578085.md](perf-baseline-7c578085.md). This branch incorporates reviewed main `2e7ec1e8a67a6cb1bc8579b1ecd7123585956722`, including draft/send certainty, upload recovery, SW33 and DB11. No services, accounts or native user histories were changed. Raw final measurements: [bot-chat-performance-098e1aae.results.json](bot-chat-performance-098e1aae.results.json).

**Dense cached chat opening improved from 2,928 to 183 ms; offline opening from 2,046 to 151 ms. Ten deltas now render 10 affected bodies and zero unchanged bodies, previously 4,000 bodies.** Closed large-tool events are compact before both replay storage and browser delivery. One warm-cache scenario still missed the 200 ms target; explicit full-detail transfer and native first-read costs remain the main follow-ups.

## Actual comparable measurements

Production React 19.2.6, existing Chrome 154 on the same Linux x64 fixture host, 1280×900, no CPU throttle. Real workspace, markdown, client, timeline, native browser IndexedDB and history projection modules; synthetic public fixture data/RPC/download boundaries. The comparable harness stubs the site header as the baseline did; the independent layout gate uses the actual header and built global CSS. **These are desktop synthetic timings, not iPhone/Safari, battery or production server measurements.** Opening figures are individual observations, not p95s.

| Same fixture | First latest paint, before → after | Warm repeat, before → after | Offline navigation, before → after | First / unchanged-repeat response after |
|---|---:|---:|---:|---:|
| 20 short turns | 367 → 416 ms | 166 → 133 ms | 160 → 169 ms | 33,003 / 84 B |
| 20 dense turns, 400 messages, weak link | 6,901 → 1,283 ms | 2,928 → 183 ms | 2,046 → 151 ms | 65,948 / 84 B |
| Existing 400-turn cache | 1,250 → 151 ms | 125* → **266 ms** | 135* → 167 ms | 33,003 / 84 B |
| One turn with 80 large tool outputs | 392 → 250 ms | 205 → 33 ms | 126 → 34 ms | 9,760 / 84 B |

\* The baseline replaced 400 cached turns with 20. The new implementation retains all **400 loaded entries** in memory and mounts a 40-entry body window. Its 266 ms repeat misses the ≤200 ms goal; comparing it to the baseline's reduced dataset would be misleading. First short-thread paint also did not improve. Earlier diagnostic runs observed 166 ms for the 400-turn repeat, demonstrating variance rather than satisfying the final observed budget.

Dense weak-link delay remains 600 ms + serialized response bytes / 128 KiB/s, as before; this is a synthetic RPC delay, not packet-level shaping. Initial dense payload fell from 569,128 to 65,948 B; the tool fixture from 2,907,312 to 9,760 B. Omitted older bodies and full details remain reachable with anchored pagination and explicit full-detail controls. A normal text preview now permits 16,384 characters within the page budget; it is not an invisible truncation contract.

| Work | Before | Final measurement / target assessment |
|---|---:|---|
| Dense, 10 deltas | 4,000 message renders; 897.1 ms median synchronous update | **10 affected, 0 unchanged renders**; 0.1 ms median synchronous dispatch; 27.7 ms median dispatch-to-two-animation-frames |
| Dense streaming persistence | 20 synchronous localStorage writes; 5,765,411 chars | **2 dirty-item + 2 metadata IDB puts**, 7,120 serialized chars counted after timing; 0 localStorage writes in this ~0.5 s sample |
| Tool fixture, closed | 80 mounted `<pre>` bodies; 3 scheduled image downloads | **0 closed tool bodies, 0 closed scheduled message bodies, 0 downloads** |
| A→B→A before replies | 3 requests, 2 concurrent A, stale A won | **2 requests, 1 A, no stale overwrite**; deterministic late-page/live-delta and owner-change tests also pass |
| 1,000 bots | 1,000 rows; 470 ms mount; 94.5 ms unrelated redraw | **20 rows; 29 ms mount; 0.8 ms unrelated redraw**; search reaches bot 1,000 |
| Earlier pages / return navigation | No retained per-bot reading position | Old anchor remains mounted across 40-entry window boundaries; measured drift ≤0.313 px; return offset error ≤0.204 px |
| Delayed image, following latest | Previously unverified | Initial and final bottom gap **0 px** |
| Huge readable answer | Previously unverified | **340,012 characters** available; final text reached through explicit Last part, 8 detail chunks; 36,990 total mounted text chars across the window |
| Offline after Chromium process restart | Baseline only tested same-session navigation | **88 ms** useful latest paint; 9 cached histories retained; 34,270-character previously opened tool available; **0 history RPCs / downloads** |

The two-frame streaming observation includes a deliberate 16 ms publish coalescer and the measurement's two animation frames. It does **not** establish ≤16 ms markdown CPU cost; this stricter target remains unproven. The 400-turn stream targets a nonvisible old message and correctly renders zero bodies; it is not counted as an affected-body performance win. Snapshot persistence remains coalesced at up to one write/second plus lifecycle flushes, rather than eliminated. The raw JSON preserves all scenarios, counters and timings.

## Live-event wire/storage correctness

The actual `BotRuntime.emitEvent` → SQLite replay → real `BotsClient.receive` → timeline regression sends one 1.45 MB completed tool item and ten 1.10 MB output deltas. A **16 KiB native-event threshold** replaces oversized payloads with ordered compatible `history.refresh` descriptors before persistence and emission; full native items remain authoritative.

- Original JSON payload total: **12,451,166 B**. Compact emitted event total, including event envelopes: **1,981 B**. Persisted replay JSON, including the subsequent completion checks: **2,473 B**. These are serialized JSON bytes, not SQLite disk or compressed transport measurements.
- Closed tools caused **0 detail requests**. Known closed descriptors do not fetch a history page per output delta. Unknown items/turn reconciliation coalesce; small ordered deltas remain intact.
- An already-open tool reached the full authoritative final output and completed status with **1 coalesced native scan**. Explicit opening transferred **1,504,557 B**; final open-detail refresh transferred **1,504,585 B in 30 chunks**. Open full detail is therefore still expensive on a weak link; this is not hidden by the closed-tool gain.
- Temporary server item snapshots deduplicate serialization/hash/native reads across 48 Ki-character continuations and validate versions. A separate 2 MB item test reconstructs every byte with exactly **one native detail lookup**, rather than one lookup per continuation. Sparse `turn/completed` settles existing entries, and work labels use individual item status.
- Mounted readable previews do not enter full-detail refresh merely because a turn completed. Oversized text deltas coalesce bounded-view refreshes. Open full tools use at most one request chain plus a trailing coalesced invalidation check; descriptor rerenders cannot start a second lane.

## Contracts and implementation boundaries

The workspace delegates history to `timeline-controller`, `timeline-cache`, `timeline-detail-cache`, `use-timeline`, and `timeline` modules; it is smaller than the reviewed base. `history-view` and `history-events` isolate bridge behavior. Draft-store/composer operation identity, uncertain-send outcomes, staged file bytes and native history are preserved.

- `history.view` projects full native data into ≤40 entries and a nominal 96 KiB response budget, with completeness, revision, event cursor and anchored older cursors. Tools-only tails carry bounded readable user/assistant context. Scheduled-run inspection uses the same item paging. Files/artifacts have an explicit paginated metadata disclosure; full detail preserves commands, reasoning, diffs and image references. No native summary semantics are assumed.
- Requests deduplicate by owner/bot. Selection cannot redirect a response into another bot's view. Owner revocation ignores late replies and stops continuation. Bounded reads may finish into their original bot's cache after navigation; socket RPC transport is not physically cancelled on each selection.
- Disjoint cached/new tails retain explicit missing intervals. Regression loads all 400 intervening items across cache close/reopen. Cache eviction retains cursors; a distant reading anchor keeps 40 nearby entries plus the latest 200, with an explicit gap between them. Complete native history remains available online; the disposable cache does not claim complete offline history.
- IndexedDB stores dirty entry records separately from small metadata. A 250 ms maximum write interval flushes during sustained streaming and on completion/navigation/hidden lifecycle. It never traverses/serializes full native histories or calls body `getAll()` per token. Tests verify sustained writes, identities and cross-owner isolation. The older durability cache is read as a migration source and is not deleted by this pass.
- Cache limits: 12 recent controllers/histories, 240 projected entries per durable history. Completed explicitly opened details: ≤4 MiB/item, ≤12 MiB total, ≤12 items in a separate disposable store. These limits never evict draft/outbox/blob stores. An uncached full detail has an explicit reconnect message. Projected history is bounded by entry/text limits, **not a strict aggregate byte quota**; very large allowed datasets and accumulated attachment metadata remain a memory/storage concern.
- Text/tool bodies are paged and memoized; closed disclosures never instantiate them. Consecutive work items share a compact outer disclosure. Saved anchor/follow-latest state and ResizeObserver handle page insertion and late images; Jump to latest is immediate. Sidebar windowing mounts at most 20 rows and searches the full bot list.

## Layout and verification

Independent `bc93e48` review scenarios/assertions were preserved; only synthetic history RPC responses were adapted to `history.view`. On the combined source, the release gate reports **no findings and no browser exceptions**, including the task overflow fix supplied by reviewed `2e7ec1e`.

| Actual release fixture | Input bottom / visible bottom | Input height | Status scroll width / viewport |
|---|---:|---:|---:|
| 390×844, keyboard visible height 400 | 390 / 400 px | 72 px | 390 / 390 px |
| 320×640, keyboard visible height 330 | 320 / 330 px | 59.39 px | 320 / 320 px |
| 390×844, keyboard hidden | 810 / 844 px | 180 px | 390 / 390 px |
| 320×640, keyboard hidden | 606 / 640 px | 180 px | 320 / 320 px |

Both keyboard screenshots were inspected. Recovery errors wrap inside a bounded scrollable/collapsible area; input, attachment and send controls remain visible. One earlier pre-integration review run had a transient browser-back queue-input assertion failure; it did not reproduce in subsequent runs, including this final unchanged-assertion gate. The separate workspace browser test also passes Activity/back navigation, typing during refresh, late sends, offline text/file-byte recovery and local previews.

Checks actually run on the final production source: **production build + 186/186 app tests; 47/47 bridge tests; TypeScript no-emit; scoped ESLint (0 errors, one existing image-element warning); performance browser; independent release browser; workspace browser.** The 18-test focused timeline/runtime subset passed before the full suites. No deployment, relay dry-run or live native service restart was performed.

The isolated pinned **Codex 0.156.1** probe reports `thread/items/list` **unsupported (-32601)**, matching the 0.157.0 result. Both synthetic `summary` and `full` still fail to hydrate the injected command item: tool-summary semantics remain **inconclusive**. This implementation uses an explicit application projection instead.

## Remaining priorities and precise limits

1. **Native/open-detail IO:** native `thread/turns/list` still reads 20 full turns for initial projection and item search. The browser page is bounded; bridge native input is not. Open large tools still transfer/assemble a full version before paged display. A verified native item/delta API, or an incremental server item index/spooled detail protocol, is the next substantial improvement. Temporary server detail cache is 30 seconds, about 32 MiB/5 items with an explicit single-oversized-item exception; live aggregate diff/plan supplements are also bounded with an oversized newest-item exception. Expired aggregate views say so; individual authoritative native items remain accessible.
2. **Performance budgets:** the observed 266 ms warm 400-turn opening misses 200 ms. Confirm p95 on repeated cold/warm runs and actual mobile hardware before tuning bounded markdown scheduling. The existing data establishes zero unchanged-body renders, not a universal ≤16 ms affected markdown render.
3. **Durability/scroll breadth:** this harness restarts Chromium with a synthetic profile and offline history transport, while serving its test shell locally. It does not certify actual SW installation, iOS process eviction or true offline application startup. The manager's independent packaged PWA runner covers that artifact gate separately. Physical restoration of a distant, previously evicted reading anchor is covered by cache/data regression plus browser navigation/late-image checks, not every cold mobile layout combination. Explicitly opened >4 MiB details are not retained offline; readable projected messages still are.
4. **Memory/account lifecycle:** full details are assembled in memory on demand; history attachments and application-selected legacy cache can add memory beyond preview budgets. New stores are owner-keyed and inaccessible after owner change, but this pass does not synchronously erase all disposable IDB history on signout. It never clears critical drafts or file bytes. Native bridge restart/combined client release must be coordinated by the manager.

## Rerun against integrated changes

Run from the repository root with existing dependencies and Chrome. No production service is needed; all fixtures use temporary isolated profiles and synthetic data. Run timed browser commands without a concurrent build.

```sh
mkdir -p outputs
npm test
npm run bots:test
npx tsc --noEmit
node tests/perf-chat-browser-098e1aae.mjs > outputs/perf-chat-current.json
node tests/bot-release-review-browser.mjs > outputs/bot-release-review-current.txt
node tests/bot-workspace-browser.mjs > outputs/bot-workspace-current.json
node --test tests/bot-timeline-098e1aae.test.mjs bot-bridge/history-view.test.mjs
PERF_CODEX=/path/to/pinned-0.156.1/codex node tests/perf-native-items-098e1aae.mjs > outputs/native-history-current.json
```

`BOT_TEST_CHROME` selects Chrome for browser runners. The optional native probe requires existing Linux `bwrap`; it hides the real home and disables networking, starts no model turn and executes no tool command. The historical baseline remains in its original report/results; use the new named scenarios to compare subsequent integrated chat changes. Sync, task list and SW performance implementation belong to the other reviewed pass and are not remeasured or claimed here.
