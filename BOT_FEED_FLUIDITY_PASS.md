# Chat feed fluidity — 25 turns, explicit reading intent

Base: `6ad69eac3696c04b4f351830025ed57cb59f5b73` (v138/SW35). Branch: `codex/bot-typing-recent-3d829950`. No Tasks/SW, draft/outbox, operation-certainty or original-file storage changes. No publication or production restart.

## Independent review corrections after f9850af

The initial navigation inspection below missed three counterexamples identified by the independent backend review. They were reproduced against the exact `f9850affeb291b3a5d9a616451b6790588fe5d1a` sources, then recalculated against the corrected modules. These are focused numerical diagnostics, not an automated regression suite.

| Counterexample | At f9850af | Corrected observation |
|---|---|---|
| 25 turns, two readable items each, 230 active tools in turn 24 | Active cap starts at `t12:u12`; completion refresh produces turns **12…24, 0…11**, Latest=`t11:a11`, obsolete oldest cursor, complete=false | **0…24**, Latest=`t24:a24`, oldest cursor=null, complete=true; 50 readable entries, zero completed tools. Active/completed page sizes unchanged: 57,011 / 14,922 bytes. |
| Retain turns 30…39 while a gap still references stop 20 | Invalid interior gap survives with a missing older endpoint | Zero interior gaps; ordinary older boundary before turn 30. Backward recovery adds **25 then 5** entries, finishes with 40 ordered entries, null cursor and zero gaps. |
| Native exhaustion before a gap endpoint is found | Empty exhausted response retains its old gap cursor | Gap closes on exhaustion; no exhausted-cursor retry loop. Canonical alias endpoints also close the gap and retain the reader's −12px offset. |
| Forward page containing 300 short entries in one turn | Entries0…255, `newerCursor:null`; final 44 unreachable through this cursor | **256 + 44**, through entry 299, then null cursor. First response 80,521 bytes (61-byte continuation overhead). This is the same truncation failure as the review's entry 207 fixture, with smaller item text. |
| A readable newer turn separated from its anchor by 25 empty turns | Zero entries, null continuation | `t26:a26` returned immediately; empty native pages do not erase the nearest useful page. |
| Byte cap: 300 entries, each with 1,200 text characters | Truncation/cursor risk | **113 + 112 + 75** entries, no gaps or repeats; largest response 170,282 bytes, below 192KiB. |
| Forward traversal over 75 ordinary turns | Turn/cursor limit must remain explicit | Exactly **25 + 25 + 25** turns; final cursor null. |

`history-reconcile.ts` now weaves overlapping pages around native keys/nonempty client IDs instead of appending every new item. Native page order controls overlap; local-only entries retain their neighbouring anchors. Live content newer than the request still wins, while canonical identity replaces a provisional ID. Calculations preserve two intentional equal-text messages with different client IDs and the newer live answer. No timestamp sorting or text deduplication is used.

`history-window.ts` validates both gap endpoints and their chronological order during retention, normalization and hydration. Eviction/removal widens an interior boundary to surviving neighbours or converts it into an ordinary older boundary. Tool-removal anchor fallbacks are separate from canonical identity aliases, so a reading-anchor fallback cannot falsely close a history gap. `fillGap` recognizes canonical endpoints, closes at definitive native exhaustion, updates an oldest boundary it extends, and reports a non-progressing response as a recoverable error. Sparse terminal events schedule one coalesced latest refresh so removal of a tool-heavy tail admits older readable content.

`conversation-view.mjs` now retains a bounded nearest projected buffer across native pages and separately records whether newer projected entries were discarded. It no longer constructs an unbounded projected native-page array in the forward scan. The existing 25-turn / 256-entry / 192KiB response bounds remain. Native full-turn reads and scans to locate old anchors remain a limitation; this does not reduce them to a delta/summary API.

Backward empty pages keep advancing native cursors: the diagnostic's sequence is 2→4→6→null, ending in the available answer. An initially empty feed makes **one** automatic continuation; if it is still empty, an accessible Continue control remains. This deliberately stops a long fully-filtered stretch from causing an all-history fetch cascade. In the 390px rendered inspection, requests stayed at 2 during 1.1 seconds idle; clicking Continue made request 3 and displayed 75 entries / 25 turns, still following latest. The empty state no longer falsely presents a brand-new conversation. An unusually long fully-filtered stretch may therefore need explicit continuation; ordinary populated feed paging remains automatic.

Rendered completion inspection used the real workspace/controller and the actual projection's synthetic pages: reader anchor `t18:a18` remained fixed across removal of 230 tools and backward expansion, with **0.313px rounding drift**; all 27 sampled post-refresh frames had the same offset, following remained false, and the last row was turn 24. Screens were inspected: `outputs/bot-typing-recent/review-active-reader-390.png`, `review-completed-reader-390.png`, `review-empty-continuation-390.png`, `review-empty-recovered-390.png`, `review-latest-390.png`. This is local Chromium inspection, not physical iPhone/Safari verification.

Compatibility: response/cursor fields and IndexedDB schema are unchanged. Existing native/before/after cursors still work. The conversation revision advances to `conversation-v2` so a previously cached bad ordering cannot indefinitely receive `unchanged`; its contents remain readable offline and are reconciled on the next online refresh. In-memory cached provisional/canonical snapshots hydrate as one canonical row, retain their gap and reader offset, and invalidate only the old revision. No draft/outbox/blob/native-history records are removed. The manager-coordinated bridge reload already required for this pass remains necessary; none was performed here.

Reproduce the exact before/after calculations (temporary bundles/results are ignored under `outputs/`):

```sh
BOT_FEED_REVIEW_REF=f9850affeb291b3a5d9a616451b6790588fe5d1a BOT_FEED_REVIEW_LABEL=before node diagnostics/bot-feed-review.mjs
BOT_FEED_REVIEW_LABEL=after node diagnostics/bot-feed-review.mjs
```

The diagnostic prints ordering, oldest/newest cursors, cache/gap/alias variants, bounded byte counts and empty-page progress. It bundles real modules from the specified Git snapshot or working tree, uses only in-memory synthetic native pages, and never calls a native process or user account. `review-pages.json` also exposes its projected active/completed pages for direct browser inspection. Detailed observations are saved in `review-before.json`, `review-after.json`, `review-rendered-completion.json` and `review-rendered-empty.json`.

The existing `node diagnostics/bot-feed-inspect.mjs` was rerun: 25 tool-heavy turns remain 1 RPC / 30,371 bytes; the 1,000-tool huge-turn page remains 46,927 bytes with summaries/files and full-answer continuation preserved. Final correction checks: scoped TypeScript, ESLint, production build and diff check. No automated test suites were added or run. Return this commit for independent re-review; no self-release.

## Changes and causes

- **Typing:** the live textarea was collapsed to `height: 0` to measure every value change. Its 40px minimum temporarily replaced a 64px two-line editor, enlarged the feed by 24px and clamped its scroll position. An offscreen value-only mirror now measures wrapping; the live height changes only when its required height changes. Placeholder, empty/clear, restored value, width/font, Activity and keyboard geometry remain covered by the existing observers.
- **Reading:** `use-feed-scroll.ts` owns intent and message/pixel anchors. Only an intentional scroll to the true newest end or Latest resumes following. Updates, resize, late images, page insertion and cache refresh restore the saved position. Near-edge user scrolling shifts overlapping windows and requests earlier/forward gap pages automatically. Requests are deduplicated; there is no render-driven fetch cascade. Offline/error controls remain available. Native and cached boundaries cannot masquerade as the global bottom.
- **25 turns:** `projection: "conversation"` filters completed tools *before transfer*, retaining user/assistant messages, plans, available reasoning summaries, and bounded file metadata looked up by turn. Adjacent summaries share a lazy Thinking disclosure. Active work remains lazy and disappears on terminal turn status, including sparse completion events. Normal reasoning detail strips `content`; no additional private reasoning is requested. Full native history and the legacy diagnostic routes remain authoritative and untouched.
- **Duplicate bubble:** manager receipt evidence established one native user item plus its provisional alias, sharing one nonempty `clientId`. Timeline reconciliation now uses that identity across events, pages and hydrated caches; canonical IDs win late provisional replays. Saved anchors follow aliases. Different client IDs with identical text remain separate. This corrects display reconciliation, not a native double-send. Send/draft/queue code was not changed.

## Measured results

Local Chrome 154, desktop host; 320×844, 390×844 and 1440×1000 viewports. No accounts or native Codex processes. The diagnostic uses real workspace/controller/IndexedDB and real bridge projection/detail/SQLite modules with synthetic native responses. These are **not iPhone/Safari timings**. Byte counts are uncompressed JSON response payloads, excluding transport framing. Native byte counts serialize synthetic Codex responses, not live Codex I/O. Chromium demonstrated the transient geometry/clamp; the physical Safari oscillation itself was not observed.

| Scenario | Before / reference | After / observation |
|---|---:|---:|
| Five characters in an existing two-line draft, simulated 400px keyboard viewport | 10 live height writes; transient 64→40→64px; lost 24px bottom alignment | 0 live height writes or live `scrollHeight` reads; all 26 sampled frames at 64px; fixed anchor offset |
| 25 tool-heavy turns: one user, one summary, 40 tools, one answer per turn | Exact 6ad projection: 27 RPCs / 238,077 bytes | 1 RPC / 30,371 bytes (**87.2% less browser data**) |
| First response from that fixture | 40 raw entries: 1 readable answer + 39 tool descriptors; 1 turn | 75 entries / 25 turns; 50 message bodies; 25 closed Thinking groups; **0 historical tools** |
| Native responses to reach those 25 turns, synthetic serialized bytes | 27 reads / 76,418,316 bytes | 1 read / 3,537,878 bytes; still a **full native read**, not a summary read |
| Single turn with 1,000 completed tools and a 260KB answer | Native tools remain authoritative | 46,927-byte page, 25 turns, 0 tool descriptors; 16,384-character answer preview with explicit Continue; returned tool-produced file metadata retained without its path/body |
| Explicit complete answer retrieval | Full answer required | 260,124 JSON characters, 6 transport chunks, **1 native lookup**; no content discarded |
| Stream + typing while reading above latest | Must not follow automatically | Same visible message, **0px offset drift** |
| Late image above reader | ≤1px rounding target | Same message, **0.25px drift** |
| Automatic prepend | ≤1px rounding target; one request per edge approach | **0.094px drift**, one request; no idle pagination cascade |
| Fresh JS context, offline cached opening | Useful paint ≤200ms on fixture host | **80.8ms**, **0 history RPCs**, same anchor/offset and restored draft |
| Cached provisional + canonical aliases, plus identical text with another client ID | 3 stored rows | 2 canonical rows stored/rendered; mapped anchor within 0.313px |

Unchanged revision also returned the small `unchanged` response. Direct rendered navigation traversed a 150-turn history in both directions through cache eviction/gap boundaries; following stayed false until intentional arrival at the newest end. Sparse completion removed active tool entries from both timeline and persisted normal cache while retaining the user, reasoning summary and answer.

At all three widths, empty/cleared input was 40px without focus. Normal long drafts capped at 180px. Wrapped/multiline heights changed in line-height increments; bottom gap remained 0. Simulated keyboard screenshots retain the input within the available viewport. Browser screenshots were personally inspected for the maintained visual direction.

## Limits and coverage

| Boundary | Before | Now |
|---|---|---|
| Visible window | 40 raw items | Up to **25 native turns**, independently capped at **256 entries / 256KiB** projected data |
| Normal history response | 40 raw items / 96KiB; native page 20 full turns | Up to **25 turns / 256 entries / 192KiB**; native page 25 full turns. An inside-page anchor can fill from one adjacent native page. Pathological turns expose continuation through cursors and partial-turn/complete-item metadata. |
| Live/persistent recent entries | Persistent 240 raw entries (reader40 + latest200); live loaded entries unbounded | Latest **100 loaded turns**, plus at most one distant **25-turn reading window**, within a combined **2,000 entries / 4MiB**; 12 controllers/threads. Pruning is coalesced with persistence. |
| History attachment metadata cache | Accumulated metadata | At most 512 records / 256KiB; retained turns, explicit links/input paths and recent arrivals. Full library remains in Attachments/Artifacts. |

“100 cached turns” is capacity, not eager prefetch: first open fetches 25; scrolling loads more. Evicted ranges retain explicit gaps/cursors and forward/backward recovery. Existing draft, blob, outbox, legacy history and opened-detail durability stores are not deleted or replaced.

Remaining limits: native `itemsView: full` still reads tool payloads; locating an old/evicted native anchor can scan multiple full native pages. Native summary semantics were not assumed. An explicit full-message Continue still fetches the complete item and can be expensive for exceptionally large answers; initial feed rendering remains bounded. Phone Safari momentum/focus behavior needs physical-device confirmation. Automated regression suites were **not** added or run in this follow-up; existing tests that require completed tools to remain in the normal timeline need their old contract reviewed during integration.

## Reproduce and inspect

```sh
node diagnostics/bot-feed-inspect.mjs
node diagnostics/bot-feed-preview.mjs
```

The first command loads the exact base projection from Git, prints numerical comparisons and writes `outputs/bot-typing-recent/projection-comparison-exact.json`. Override `BOT_FEED_BASE` only when deliberately changing the baseline. It uses temporary synthetic SQLite data and cleans it up.

The second launches a disposable localhost workspace and headless browser (no production service). Its console exposes `await feed.open()`, `feed.geometry()`, `feed.snapshot()`, `feed.event(method, params)`, `feed.cache()`, `design.restored(value)`, `design.keyboard(height)` and `design.select(botId)`. Use `diagnostics/bot-feed-cdp.mjs` to attach through the printed connection file; send real wheel/text CDP input, sample with `requestAnimationFrame`, and capture PNGs. Ctrl-C cleans up its own browser/profile/database. The preview covers history/composer; it is not an artifact-gallery backend fixture.

Actual inspection evidence in this worker's `outputs/bot-typing-recent/`: `baseline-typing.json`, `after-typing.json`, `prepend-frames.json`, `retention-navigation.json`, `composer-geometries.json`, `cold-offline.json`, `cached-alias-migration.json`, `stream-images-completion.json`. Screens: `recent25-320.png`, `recent25-390.png`, `recent25-1440.png`, `keyboard-320.png`, `keyboard-390.png`, `cold-offline-390.png`, `cached-aliases-390.png`, `auto-earlier-390.png`, `stream-reading-390.png`. Outputs are disposable and not committed.

Checks actually run: `npx tsc --noEmit`, scoped ESLint on changed modules/diagnostics, `npm run build`, `git diff --check`, the printed runtime diagnostic above, and direct rendered CDP inspection. Build/type/lint passed. A single **manager-coordinated bridge reload** is required after integration for the new projection/cursors; no worker restart/deploy occurred.
