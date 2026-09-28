# Conversation / Activity first pass — ae57719

Base: `54c70a7a2f5757dd97af537c341e4b02316a3321` (v141). Branch: `codex/night-conversation-ae57719`. The clean owned worktree already matched this exact base; a new branch preserves the prior branch/history. This is an implementation for manager review, not a release.

## Cause and change

The former projection counted every native scheduled turn against the same 25-turn window and the timeline folded all items of a turn containing `schedule:` into a scheduled card. The recorded Connie PWA observation in `BOT_ARCHITECTURE_PLAN_20260927.md` matches these source paths. I read that recorded observation; I did not reopen Connie or send a message.

- `lib/bot-conversation.ts` classifies a **full native turn** using schedule input provenance and existing run records. Routine turns are excluded **before** filling the page. A known scheduled turn with a human input is mixed: keep the human input, available surrounding replies/plans/reasoning summaries, and files. Only the schedule trigger and internal manager-notice input are removed. Ambiguous legacy cached context remains readable until an authoritative native page classifies it.
- `bot-bridge/conversation-view.mjs` scans past routine/empty native pages to fill 25 useful turns, or stop at payload limits/native exhaustion. It preserves raw native cursor anchors. Forward paging retains the nearest bounded newer page and its continuation. Cyclic native cursors fail explicitly. No native history is changed.
- Completed historical tools are omitted from Conversation payload/entries, not hidden with CSS. Active human-turn work remains lazy. Reasoning `summary` is retained and raw `content` is stripped. Tool-origin file metadata is queried by visible turn provenance without reading tool bodies in the browser.
- Explicit successful `bots_report_result` items yield formatted actionable findings with a full-run link. The explicit finding key + summary matches the existing notification dedup semantics; duplicate loaded reports are collapsed without using them as chronological page-overlap anchors. Ordinary scheduled final prose is not guessed to be a finding.
- `timeline-controller.ts`, `history-reconcile.ts`, and cache metadata carry classification through refresh/live events/offline hydration. Canonical user `clientId` identity, ordered page weaving, gap repair, existing reader intent and persistence lanes remain in use. Known active classification is protected from older-history metadata eviction.
- Conversation now has a compact Activity destination and active-background-work link. Activity has local date groups, friendly states, upcoming work, 25-run pages, page-scoped counts/attention filter, bounded full-run detail, lazy closed tools, retry/empty/offline states, and a full-width phone drawer. Its first page is cached by the existing owner-scoped disposable client cache. The main conversation stays mounted behind it. Errors appear at the top; footer/Close remain reachable.

No edits to runtime.mjs, manager/store, client transport, composer settings/styles, default-tab preferences, draft/outbox stores, Tasks, or SW.

## Bounds and pagination reasoning

| Surface | Bound after change |
|---|---|
| Conversation page | 25 projected native turns; 256 entries; 192 KiB response budget, with attachment/classification/envelope reserve |
| Visible feed | Existing 25-turn / 256-entry / 256 KiB body window |
| Retained history | Existing 100-turn / 2,000-entry / 4 MiB tail; 12 durable threads |
| Attachment metadata | Existing 64 records / 24 KiB, scoped to selected turns/items/paths |
| Activity list | 25 runs/page; only first page cached here; no full-library count |
| Explicit run detail | Existing 40-item / 96 KiB page; full item text only on demand |
| Excluded-turn metadata | Up to 128 turns / 8 KiB per response; controller trims older classification around 384, retaining loaded/known-active turns |

Backward cursors point to the next unconsumed raw native item/page, including when a safety cap splits one huge turn. Skipped routine items do not use conversational slots. A page ending exactly at a native page boundary retains that native continuation. Empty/routine pages continue until useful content or actual exhaustion. Forward scans keep raw anchor lookup separate from filtered entries and preserve a `newerCursor` when the bounded nearest page excludes newer material. Existing native/client identity keys remain the basis of merge/gap ordering; timestamps are not used to sort messages.

Full historical reasoning summaries and tools remain available in Activity/detail. Oversized messages keep the existing explicit Continue/full-message pagination. Native history and critical drafts/file bytes are untouched.

## Evidence actually gathered

No automated tests or test suites were added or run. Manual browser inspection used the real Workspace, timeline/cache, BotRuntime history adapter, and temporary SQLite with synthetic native pages in a disposable Chrome profile. `diagnostics/night-conversation-preview.mjs` + `night-conversation-fixture.jsx` are manual preview tools, with no assertions/scenario runner. They dispatch only read operations; they do not connect to a user account.

Fixture: 235 native turns, 175 scheduled run records, 60 ordinary human turns, one legacy mixed turn, one explicit finding, and 55 scheduled turns at the newest end. Most scheduled turns include a 42 KB synthetic tool output.

Observed before the final optional `active` classification flag (adds 14 bytes to this page, no rendering change):

- Initial Conversation: **25 useful turns / 74 entries / 33,723 response bytes**, from **5 native reads of 25 turns**. It contained 23 ordinary human turns, one mixed human turn, and one actionable finding. Routine completed tools were absent from normal entries. The old algorithm would count the newest 25 scheduled turns and admit **zero ordinary human turns** on this fixture; that comparison is source-derived, not an executed old-build benchmark.
- A rendered Home-key approach to the top loaded another 25 useful turns: **50 retained turns, 149 item keys, 149 distinct keys**. The older cursor advanced from native offset125 to200. No automated completeness suite was run; further cursor/eviction reasoning was source review.
- Activity: **25 rendered cards**, first-page response **7,302 bytes**. An explicit run page was **1,809 bytes** on the final-date fixture. Closed tools issued **0 history.detail requests**; opening one issued **1 request / 42,303 bytes** and displayed its full synthetic output.
- Reader inspection: opening/closing Activity at 390px preserved `human-37:user-37` at **7.6875px**, following=false. In a separate rendered inspection, a synthetic live answer delta while reading earlier preserved `human-36:answer-36` at **−31.921875px**, following=false. These are narrow observed interactions, not exhaustive momentum/image/Safari coverage.
- Phone body widths measured **320/390px** at the respective widths; desktop **1440px**. Phone Activity fits the viewport (390×844, and 320×780); its footer bottom measured exactly844/780. Visual inspection caught and corrected inherited modal padding and an empty-state footer placement problem.
- Personally inspected actual screenshots of Conversation and Activity on phone/desktop; full run detail, 320px offline list, 390px empty/error states. Error/offline/empty transport states were changed only in the disposable fixture. Existing draft controls were not exercised against real storage.

Final checks: `npx tsc --noEmit`; scoped ESLint on all changed TS/TSX/MJS/JSX; `npm run build`; `git diff --check`. Build completed with the existing vinext route-classification informational note. No automated suite, native binary probe, production PWA, physical iPhone, or Safari verification is claimed.

## Compatibility and remaining dependencies

1. **Backend execution isolation still required.** Current runtime can steer a human into an active scheduled turn. This UI deliberately preserves mixed dialogue; it cannot safely change execution routing. Request is in manager workspace `NIGHT_CONVERSATION_CONTRACT_ae57719.md`. If the backend uses separate run threads, add owned `BotRun.threadId` and `history.view/detail({runId,...})` routing with legacy main-thread fallback before integrating that routing model. Current first pass uses the existing same-thread `turnId` detail API.
2. **Native read cost remains.** `thread/turns/list` still requests full items. This implementation bounds browser response/cache/mount work, not total native scan time. There is no arbitrary two-page stop that strands human history: very schedule-heavy threads may scan many native pages and hit transport latency. The store run lookup and existing `runs.page` also materialize all run records. An indexed display-history/run query is the next performance boundary; upstream savings are not claimed.
3. **Finding authority is incomplete upstream.** Existing notify records lack run/item provenance. Recovery uses verified protocol fields on explicit successful reporting-tool items; once-only behavior is limited to loaded projected entries/page dedup, not a durable global finding ledger. A stable finding receipt/index plus invalidation is requested. Arbitrary legacy prose and unknown attribution remain in full run detail; mixed context is intentionally conservative.
4. **Cache rollout:** optional metadata only, no IndexedDB/schema migration. Conversation revision changes `conversation-v2`→`conversation-v3`, forcing a fresh projection online while retaining readable legacy offline data. Older native cursor format remains accepted. Old cache ambiguity can retain extra context until that range is classified. Existing native/API authorization and canonical message IDs are unchanged.
5. **Integration/reload:** history helper changes require a single manager-coordinated native service reload and rebuilt frontend to enable the new projection. No reload/release was performed here. No SW version changed in this worker scope; manager owns packaged release coordination. New UI with an old service cannot provide the new schedule-independent budget.
6. Run-list first page can be reopened offline; uncached full run pages still require a connection. Existing cached Conversation remains available. Fresh browser-process offline migration, delayed images, queue/send semantics and real artifacts were not newly exercised; those paths were source-reviewed/preserved, not re-certified.

## Manual reproduction and artifacts

Run `node diagnostics/night-conversation-preview.mjs` in this branch. It prints a localhost preview and disposable CDP connection. Open `/preview?bot=night-studio`, use Activity/Open run, and scroll the conversation upward. `window.night.offline()` changes only that disposable client. Ctrl-C removes its temporary SQLite/profile. No automated checks are attached.

Screens and measured-call notes are in manager workspace `night-conversation-ae57719/` (`night-conversation-390.png`, `night-conversation-desktop.png`, `night-activity-{320,390,desktop}.png`, `night-activity-detail-390.png`, `night-activity-offline-320.png`, `night-activity-{empty,error}-390.png`, `night-browser-observations.json`, build log). The JSON records observations before the final 14-byte active flag; timing is a local synthetic sample, not an iPhone/network claim.
