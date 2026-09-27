# Chat feed fluidity — 25 turns, explicit reading intent

Base: `6ad69eac3696c04b4f351830025ed57cb59f5b73` (v138/SW35). Branch: `codex/bot-typing-recent-3d829950`. No Tasks/SW, draft/outbox, operation-certainty or original-file storage changes. No publication or production restart.

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
