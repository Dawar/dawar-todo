# Conversation/runtime contract wiring and queue lifecycle correction

2026-09-28 · task `de69932a87cc604ebe5ade2928c12b357edfbcc2cc06ea85a0d90ac460fb6831`

Branch `codex/night-conversation-ae57719`, starting clean at `0da6842a82b3b33108a303357f0e22cc2bcda189`. First applied the exact manager shortcut child `d2d74e0afa559c42a8748024d2790101921b0712` as **`70e0159`**. Its Ctrl+Enter, IME, repeated-key, normal Enter/Shift+Enter, attachment and queue-edit paths remain unchanged. The implementation/report commit follows that child; the manager handoff gives its exact SHA.

Read `NIGHT_RUNTIME_CORRECTIONS.md`, the earlier queue contract gaps and the complete `NIGHT_CONVERSATION_QUEUE_REVIEW.md`. Integrated the **interfaces**, not backend commits, from source `7c292e35a4c534db417a8743d8b988b91e3deeb4` (report HEAD `b45d93235f1160e3c5ca05e84829be47b370ccde`). That runtime candidate remains subject to independent acceptance. Main/preferences at `6231fda` were not merged, rebased or edited. No runtime.mjs, manager, store, preference files, service lifecycle or real user data were changed.

## Queue revision contract and F1

- NEW staged `queue.update` and `queue.delete` parameters now capture the observed optional positive `expectedRevision`. An update's preflight still checks the editing revision; the corrected backend performs the authoritative comparison inside its transaction. Legacy rows omit the field.
- The existing-operation branch dispatches its already persisted parameters before constructing anything new. Retry never inserts a revision into an older payload. Delete/reorder/resume receipts still persist before dispatch, and only matching success or definite rejection retires them. Unknown outcomes retain the exact ID, parameters and recovery controls. Definite update rejection retains the draft and attachment references.
- F1 root cause: React Activity disconnects effects when hidden, but preserves component state. Previously the hook cleared its receipt/in-flight ref on hidden acknowledgement while skipping React pending/busy settlement. Return only reactivated the effect, leaving the controls locked. Settlement now uses the **origin owner**, independently of presentation visibility. Resume also mirrors the actual pending/in-flight refs. Starts and visible refreshes retain their visibility/owner fences.
- The same audit corrected Activity review acknowledgement busy settlement. Hidden review failures retain a separate actionable error and **Retry same review**, preserving its `run-review:<run-id>` identity instead of losing the error to a list refresh. List/detail completion clears busy state for its origin; request identity/cancellation still prevents obsolete data replacement. Returning may refetch a canceled read, never replay a review mutation automatically.
- Coarse-pointer queue icon targets are now **44×44 px**, in the existing compact two-column action group. Desktop targets/layout remain unchanged.

Transport qualification: the hook does not automatically retry durable queue actions after reload. The existing socket transport **does** replay unresolved in-memory requests on reconnect using the same ID/parameters. The earlier report wording has been corrected. This pass does not add cross-tab global serialization or claim native exactly-once execution independently of the backend receipts.

## Continuation discovery, projection and live attribution

Additive types preserve the prior optional queue fields and match the corrected public contract: `BotRunTurn`, `BotRunTurnPage`, `BotScheduledTurn`, `BotScheduledEventData`, `snapshot.activeScheduledTurns`, and `runs.turns({runId,cursor?,limit?})`.

`run-turn-picker.tsx` is a separate Activity component. Its disclosure lists the original run plus **25 continuation metadata records per requested page**, in the service's stable identity order. It neither calls native history to enumerate follow-ups nor sorts across page boundaries using mutable dates. Dates may explicitly be unavailable. Unconfirmed records without a native turn cannot open a fabricated transcript. Selecting a known turn uses its original `turnId` through the existing bounded `history.view`/on-demand detail routes; only one transcript is mounted. The original run ID and turn ID are never replaced.

The picker shows honest page counts, previous/more controls, read retry, update and offline states. A failed next-page request retains the last loaded page and disables advancement from its stale cursor. New events show an update cue rather than replacing the reader's page. An explicitly refreshed current transcript retains its scroll offset; selecting another part starts that part at the top. Disposable continuation cache `activity-turns:v1` holds at most **eight first pages per owner across bots**, metadata only (cached errors capped at 512 characters). Existing draft/history stores and DB versions are untouched.

`conversation-view.mjs` now looks up exact primary/continuation receipts per native turn, using the corrected runtime's additive indexes instead of loading the entire run registry for projection. Continuation lookup checks bot, parent run, native turn, compatible thread and acknowledged running/terminal state. Older runtimes without continuation discovery keep unknown follow-ups visible. An uncertain receipt is conservatively visible, even if it has a turn ID. The full native turn is still inspected for human input: mixed turns keep their human messages and surrounding replies. Successful structured `bots_report_result` findings remain in Conversation with their full-run link. Completed tools stay out of the normal payload; reasoning summaries and bounded attachment metadata retain existing behavior.

Selection still counts **25 useful conversational turns after projection**, following native pages through intervening routine work until that budget, existing item/byte safety bounds or actual exhaustion. No hiding scan cutoff was added. Native cursor/order, gap and canonical-client-ID algorithms are unchanged. Conversation cache revision becomes **`conversation-v4`**: old cached entries remain available offline, but require an authoritative refresh rather than being treated as current projection.

Snapshot/event attribution drives the compact active-work link, including a continuation whose primary run is already completed. `activeScheduledTurn:null` clears only that bot's active attribution; a missing field preserves old-service behavior. Schedule patches participate in existing snapshot cursor ordering, so an older snapshot cannot restore stale active state. `runTurn` events invalidate the projection even if a history response already covered their sequence; reconnect metadata can also trigger a refresh. A receipt alone never hides a partial cached turn: the full projection must classify it. Schedule-event metadata is considered before returning `unchanged`, even when native text/version did not change; a replay gap also forces projection.

## Evidence actually gathered

No automated tests or suites were added/run. Used the interactive synthetic preview:

```sh
node diagnostics/night-conversation-preview.mjs --queue --continuations
```

It uses a disposable browser profile/SQLite database, the real workspace/client/timeline/composer, generated native pages and the exact candidate's **read-only `run-turns.mjs` adapter** extracted to a temporary file by `git show`. It does not import/start the corrected runtime lifecycle, call a real native service or use user accounts. Manual held responses are exposed through `window.queuePreview`; there is no assertion/scenario runner.

| Manual observation | Result |
| --- | --- |
| Delete, reorder, resume: each held across Activity hide/return with success, rejection, unknown outcome | **All 9 combinations** settled presentation: success/rejection left 0 receipts and usable controls; uncertainty left 1 receipt and enabled same-ID retry. |
| Unknown resume, unmount/remount then browser reload | Receipt/ID survived; **0 automatic resume writes after reload**; explicit retry remained available. |
| Held delete, change synthetic owner, then unknown outcome | Only original owner retained the receipt; new owner showed no pending-action notice. Returning to original owner exposed usable same-ID recovery. |
| Historical saved delete without revision | Explicit retry sent its original ID and `{id}` only, with **no `expectedRevision` added**. New delete and new update each sent `expectedRevision:1`. |
| Activity acknowledgement succeeds while hidden | Return had no stuck loader and enabled review controls. Hidden unknown review response kept an enabled **Retry same review**. |
| Held Activity list and selected-transcript reads across hide/return | Fresh visible reads settled; the selected original run rendered and busy state cleared. |
| 58 continuation records | Pages showed **25, 25, 8** follow-ups (plus one original-run choice). Last page had no next cursor. Selecting its first row opened original native `follow-50`, displaying Follow-up 51. |
| Metadata enumeration | First 25-record response: **5,857 JSON bytes**, **0 native reads**. |
| Conversation with 293 generated native turns, including 58 follow-ups | **25 turns / 70 entries / 33,652 JSON bytes**, **0 completed tool entries**. Kept uncertain follow-up 54, mixed-human follow-up 55 and finding follow-up 56; routine acknowledged continuations did not consume the budget. Required **7 full-item native page reads**, not a bounded upstream-cost claim. |
| New null active-attribution event followed by older full snapshot | Active array stayed empty and active-work link stayed absent. |
| Offline close/reopen of Activity after caching its first follow-up page | **25 saved follow-ups + original run**, **0 RPCs**; explicit reconnect guidance for full transcript details. |
| Coarse-pointer 320/390 px and desktop 1440 px | Body width matched each viewport; queue touch targets **44×44 px**. Personally inspected the actual rendered screens. |

Separate PNGs: `outputs/bot-typing-recent/night-wiring-390.png`, `night-wiring-uncertain-320.png`, `night-wiring-desktop.png`, `night-wiring-followups-390.png`, `night-wiring-followups-last-320.png`, `night-wiring-offline-390.png`. Manager copies are in `night-wiring-de69932a/`; images contain synthetic content only.

Final scoped TypeScript, ESLint, diff checks and production build passed. Build log: `outputs/night-conversation-wiring-build.log`; existing vinext route-classification notice remains. No main merge/push/publication, service restart, live messages/settings/drafts/files or schedules were performed. Ctrl+Enter preservation was source-reviewed here; the shortcut was not used to send a real message.

## Integration and remaining limits

- Requires accepted corrected runtime `runs.turns`, revision/outcome handling, continuation/attachment receipts and its two additive indexes. A single manager-coordinated service reload is needed for the owned projection helpers plus backend corrections; none was performed. Preserve v142 preferences/SW38 during manager integration. Shared lib additions must be combined, not replaced wholesale.
- Parent-run metadata is normally supplied by the run list/recent cache. For a direct continuation link whose parent is outside those loaded pages, its detail and follow-ups are available immediately, while the original run remains reachable through **All activity** paging. The public contract has no `runs.read` lookup; no invented operation or unbounded parent search was added.
- Full native history is still read upstream to select useful turns, and older detail lookup can scan native pages. Dense scheduled history may require many reads and hit RPC timeouts. `runs.page` ancillary records/snapshot construction still have the independently identified runtime bounds issues. The indexed projection receipt lookup and zero-native-read continuation enumeration do not resolve those costs.
- Schedules still share `main-legacy`; the backend Send guard/Queue-next alternative is not independent execution. Native attachment provenance, actual lost-ACK/crash recovery and backend revision transactions remain backend review gates, not proven by synthetic RPCs.
- Existing anchor/dedup/paging code was preserved and inspected. This pass did not newly prove simultaneous live-attribution removal during touch momentum, every large-turn/gap boundary, browser/OS termination or physical iPhone/Safari behavior. First-page continuation metadata is cached; complete historical run bodies are not newly made available offline. Backend and final conversation re-review remain required before release.
