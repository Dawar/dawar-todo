# Conversation / durable queue contract follow-up

2026-09-28 · task `f48ec47864818c6d67e77772178819006f0875073418eab36ed2e77ae66105bf`

Branch: `codex/night-conversation-ae57719`, continuing the collected `e35f355a6224e9a5be2b8fcb702a2521f78129ea`. This report accompanies the frontend follow-up commit; its exact SHA is supplied in the manager handoff. No main integration, publication, native mutation or service restart was performed.

Reviewed runtime implementation `25e928d75c8f3f91f8680287ae3a119450a86340` and report HEAD `1d5135e40333c081a07268acf15b401a1648039f` read-only, plus `NIGHT_RUNTIME_RESULT_20260928_3816777c.md` and `NIGHT_RUNTIME_REVIEW.md`. That candidate is **correction-required**, not release-ready. R1–R5 remain the runtime author's responsibility; this branch neither imports that candidate nor edits runtime, manager, store, preferences, default route or composer-settings styles.

## Implemented frontend contract

`BotQueuedSubmission` retains the existing native fields and adds only fields actually returned by the reviewed candidate:

| Optional field | Accepted values / purpose |
| --- | --- |
| `state` | `queued`, `dispatching`, `uncertain`, `failed` |
| `revision` | Number identifying the staged edit revision |
| `operationId` | Native dispatch identity, or null before dispatch |
| `waitReason` | `main-turn-running`, `needs-input`, `paused`, `delivery-unconfirmed`, `rejected`, `plan-reconciliation`, or null |
| `error` | Existing failure explanation, or null |

`prompt-queue.tsx`, `queue-state.ts` and scoped `prompt-queue.css` replace the inline workspace queue. Rows now explain what is waiting, distinguish definite failure from unknown delivery, retain attachment previews, and offer a status refresh. Dispatching/unconfirmed rows cannot be edited or deleted; their presence blocks reordering. Unknown future states fail closed. Resume is unavailable while delivery, failed-item review or Plan reconciliation needs attention. Failed items can be edited into a fresh revision and then resumed, as the candidate permits.

Mixed queues preserve the entire legacy native prefix and permit movement only within the staged suffix. Old services without the optional fields retain native-only editing/reordering. The Activity heading is now **Scheduled activity**, with copy describing recorded runs/results rather than implying independent background execution.

### Exact-action recovery and draft revisions

Delete, reorder and resume now retain their exact operation ID and parameters in an owner/bot-scoped browser record **before** RPC dispatch (`queue-action-store.ts`, `use-queue-action.ts`). Failed local persistence sends nothing. Each operation has a separate key so tabs cannot overwrite each other's receipts. Unknown outcomes survive remount/reload and lock further queue changes. There is no automatic write retry; **Retry same action** explicitly uses that same ID/parameters. Only the matching successful response or a definite rejected outcome clears the receipt. Queue-list equality does not establish operation completion. Owner changes and unmounts fence UI updates; there are no new polling timers.

This is receipt retention, not a claim of global cross-tab mutation serialization. Server state/revision fences are still needed for concurrent tabs.

Composer queue edits record the observed optional revision. Before creating a new `queue.update`, a read-only `queue.list` checks presence, editability, revision and unresolved queue actions. Existing durable composer operations skip this new-write preflight and reconcile their original ID/parameters. Reopening a changed revision preserves the prior text/file references in the established draft-recovery surface before loading the new version. Pending submissions are never replaced. These are additive draft metadata changes; the IndexedDB version, bytes, submission machinery and uncertain-send behavior are unchanged.

## Canonical identity and attachments

The candidate uses `queue-start:sha256(botId:id:revision)` for both provisional `client:<dispatch-id>` and canonical native `clientId`. `queue.add` does not create a conversation bubble in the frontend. Therefore there is no legitimate original-queue-ID bubble to alias to the hash: existing client-ID reconciliation should merge the provisional/canonical pair, while different revisions or queue IDs remain distinct. No text, image path, or content-equality deduplication was added.

The manual fixture exercised the real client/timeline/composer with that dispatch identity. One image-only provisional/canonical pair became **one** user row with its attachment retained. A second distinct queue ID with identical image input produced **two** user rows, **zero** provisional aliases, and both images decoded at natural width **192 px**. This establishes frontend identity behavior with explicitly supplied metadata, **not** native attachment provenance. Backend R4 must atomically retain immutable attachment IDs under each dispatch revision before sending and through reconciliation. The frontend does not compensate for the missing association by guessing.

## Actual checks and rendered evidence

No automated tests or suites were added or run. `diagnostics/night-queue-fixture.jsx` is an isolated interactive fixture with synthetic queue RPCs and a disposable profile; it has no scenario runner/assertions. The existing preview's fake native adapter uses generated content and an isolated SQLite database. No real account, bot prompt, draft, file, schedule or native service was used.

Manual command: `node diagnostics/night-conversation-preview.mjs --queue`. This opens the actual workspace components; `window.queuePreview` exposes synthetic rows, response failures and dispatch echoes for manual inspection. The process and browser were stopped after inspection.

| Manually observed sequence | Result |
| --- | --- |
| 320 / 390 / 1440 px viewport | Body widths were 320 / 390 / 1440 px. Phone composer bottoms were 766/780 and 830/844 px. Desktop queue width was 860 px. |
| Dispatching or unconfirmed row | Edit, delete and both move controls disabled; Resume disabled for uncertainty. |
| Needs-input / Plan-reconciliation reasons | Useful status text shown; Plan reconciliation blocks Resume. |
| Legacy-only two-row queue | Relevant up/down controls remained enabled without optional fields. |
| Edit revision 1; queue becomes revision 2 | Save made **0 update RPCs** and showed a revision explanation. Reopen loaded revision 2 and retained revision-1 recovery text/file reference (`hasBytes: true`). |
| Delete loses acknowledgement; reload | **1** initial RPC/receipt; **0** automatic delete writes after reload. Explicit retry used the **same ID**, then removed the receipt after acknowledgement. |
| Browser storage throws before delete | **0 delete RPCs**; visible explanation that the action was not sent and needs storage recovery. |
| Queue edit while another action is unconfirmed | **0 update RPCs**; edit retained with an actionable explanation. |
| Canonical dispatch echo, then distinct same-content intent | 1 row for the first pair; 2 rows for the two distinct IDs. Attachments remained present. |

Personally inspected the phone/desktop screenshots, including failed/unconfirmed status, storage recovery and Activity heading. Separate PNG evidence is in `outputs/bot-typing-recent/`: `night-queue-320.png`, `night-queue-390.png`, `night-queue-desktop.png`, `night-queue-storage-390.png`, `night-queue-unconfirmed-390.png`, `night-queue-activity-heading-390.png`, and `night-queue-canonical-390.png`. The last image intentionally shows two different queue IDs, not a duplicate. Manager copies use the unique `night-queue-f48ec478` directory.

Passed on the final source: `npx tsc --noEmit`; scoped `npx eslint` on all changed TS/TSX/JSX/MJS modules; `git diff --check`; `npm run build`. Build log: `outputs/night-queue-build.log` (existing vinext route-classification notice only). No claim of actual old-service/native queue execution, fault-injected backend recovery, physical iPhone/Safari behavior, or new frame-by-frame typing/momentum/keyboard verification. The prior history projection, paging, anchors, canonical merge and closed-tool implementation are unchanged by this follow-up.

## Required backend integration and known limits

1. **Keep R1–R5 corrections with their runtime owner.** In particular, restore continuation attribution after startup/periodic recovery, clear only the matching terminal active turn, retain immutable revision-specific attachment provenance, and safely settle local-only enqueue reservations. `plan-reconciliation` remains an optional forward-compatible UI state regardless of the final Plan implementation. Do not release the reviewed candidate on the strength of this frontend fixture.
2. **Revision compare-and-swap is not yet an API contract.** Candidate `mutatePrompt` accepts ID/input without an expected revision. The new frontend preflight prevents known stale edits but cannot close a concurrent change between read and update. Proposed contract: optional `expectedRevision` on staged update/delete, checked transactionally, with a definite rejected outcome on mismatch. No unsupported field is sent by this branch. The server should also reject reorder while any staged row is dispatching/uncertain, not rely on UI disabling.
3. **Definite queue-action rejection needs truthful outcomes.** In the reviewed candidate, generic `handle` can label local validation errors from delete/reorder/resume uncertain (the special rejected classification covers settings, not these operations). Same-ID recovery can then remain stuck. Backend should classify proven pre-effect/local transactional rejection as rejected, while retaining native/commit uncertainty. This UI intentionally keeps such receipts rather than unlocking from a matching list or issuing a different ID. The gap was sent in `NIGHT_QUEUE_CONTRACT_GAPS_f48ec478.md`.
4. **Continuation detail must become discoverable before hiding it.** Candidate `runTurn` records have `id` (= operation ID), `botId`, `runId`, `operationId`, `turnId`, `status`, `error`, and terminal `finishedAt`, but `runs.page`/snapshot do not expose a continuation list. Current Activity can open the primary `run.turnId` only. A precise proposed addition is a bounded, owner/bot/run-validated `runs.turns({runId,cursor,limit})` returning existing receipt fields plus `nextCursor`; an equivalent reviewed public contract is fine. Existing main-thread `history.view/detail` can hydrate the returned turn IDs. Separate future threads require run-authorized detail routing as well. Snapshot/event attribution must also identify an active scheduled continuation when the primary run is already completed. No invented fields or speculative projection changes were added here.

The original primary `run.turnId` must stay stable. Until continuation discovery and projection receipts are integrated together, unknown continuations remain visible rather than being hidden without a route to full detail; they may still consume conversational budget. Primary scheduled runs continue to follow the earlier 25-conversational-turn projection, with mixed human replies retained. Backend corrections to attribution must be checked against that UI contract.

Schedules still use the main thread. The current Send guard retains a rejected draft; Queue next is the compatible alternative. This does **not** deliver fully independent schedule execution or uninterrupted main-conversation input. That separate lane remains required. No native history, attachment bytes, existing drafts or cached history were deleted, and no storage/SW migration is introduced by this follow-up.
