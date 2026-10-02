# History and intake resource bounds

Native thread/turn execution and native questions remain activity authority.
These changes add resource admission and read acceleration, not workflow state.

- `HistoryReads` admits two native history pages globally, at most one per
  thread, rotating between ready threads. Identical overlapping reads share
  only the in-flight promise. Completed pages are not cached as current truth.
  Admission is bounded to128 pending reads and15seconds waiting; an unstarted
  read fails with a retryable reading error. Native RPC timeout stays unchanged.
- SQLite `native_history_locations` stores only observed thread/turn cursor
  hints and page sizes. Hints survive restart, but every use verifies the exact
  requested identity in fresh native history. Invalid hints fall back to native
  discovery. Cold detail discovery scans `notLoaded` turn metadata, then reads
  full items only from the positively matching page. No native data is deleted.
- Conversation pages scan at most four native pages per response. Empty legacy
  scheduled pages keep an exact continuation cursor; the UI can continue
  loading. This bounds individual opening requests without hiding old history.
  New ordinary scheduled responses remain ordinary conversation messages.
- An opened legacy run invalidates on its own bot's evidence, rather than on
  every other bot's global event. Global replay cursors are still returned.
- Primary intake admission rotates the first bot and prepares at most two
  bots concurrently, under existing per-bot locks and all original Stop,
  question, human/default queue and uncertainty guards. Failures back off up to
  one minute. Native execution concurrency is not inferred or model-capped.
  Single-thread bots no longer get an extra native queue poll from the legacy
  dispatcher every tick. Historical completed prompts/runs are excluded from
  recovery decoding; original rows, inputs and operation identities remain.

`/healthz.historyReads` exposes aggregate call/byte/row/coalescing/slot counts,
without identities or content. `historyCursorIndex:1` identifies this bridge
capability. Conversation projection stays `conversation-v6`; legacy run view
revision changes to `run-view-v2` with its existing consumer contract.

## PWA adoption

The build emits `pwa-build.json`, required by the strict shell precache. Worker
version diagnostics return that generation's build identity. Update discovery
runs on online/focus/visibility and every five visible minutes, coalesced with
a one-minute minimum interval. There is no forced page navigation.

The new client shows **Refresh when ready** after a new complete worker shell
is controlling it. User adoption waits for bot drafts, recoverable file bytes,
Todo capture and conversation positions to save. It refuses during a composer
commit, open task editor or active Operator/retained Talk call. The worker
fetches a fresh same-origin document and verifies every required asset before
replacing its cached document; guards save again before reload. No auth, IDB,
outbox, attachment, native history or app state is cleared. The previous shell
retention policy and narrow Mermaid/ELK internal-label exclusions remain.

## Evidence and limits

2026-10-02 disposable measurements (not suites, inference or live user actions):

| Synthetic history | Old detail before | Cold detail after | Indexed reopen after |
| --- | --- | --- | --- |
|100turns|5calls /7.44MB|6calls /1.50MB|1call /1.49MB|
|500turns|25calls /37.22MB|26calls /1.57MB|1call /1.49MB|
|2000turns|100calls /148.90MB|101calls /1.80MB|1call /1.49MB|

Cold lookup still scans all turn metadata; its row count can grow with history.
Only full item decoding drops (6000 to60 at2000turns). Full latest pages still
carry native tool payloads. An isolated0.159.3 summary/item fixture was
inconclusive, so unverified summary semantics were not enabled.

Twenty simultaneous identical pages coalesced from20native reads/37.22MB to
one/1.86MB. Twelve synthetic admission preparations used two slots instead of
one (101ms vs199ms with15ms simulated preparation). These timings describe
the disposable harness, not production throughput or model execution.

Actual `BotTimeline`, native browser IDB and `TimelineEntry` markup stayed at
50entries/535DOM nodes for100/500/2000turns. First-paint timing was noisy;
no latest-conversation speedup is claimed. Preview styles were minimal, not a
full production workspace comparison. A200-turn quiet legacy tail returns
after four pages with a continuation, rather than scanning nine before paint.

Home `PERFORMANCE_*_MEASUREMENTS.json` contains raw baseline/after measurements.
Live backend activation, real contention and owner-controlled PWA adoption
require their recorded release evidence. Dawar already verified prior iPhone
uploads/burst/queue-edit behavior; this work adds no device acceptance pass.
