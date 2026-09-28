# Night runtime foundation — 2026-09-28

Branch: `codex/night-runtime-recovery-3816777c`. Base: `54c70a7a2f5757dd97af537c341e4b02316a3321` (v141). The prior owned branch and its commits were preserved. This is a first-pass implementation for independent review, not a release or completion of the full architecture program.

Implementation commit: `25e928d75c8f3f91f8680287ae3a119450a86340`. This report is committed separately above it.

## Root causes and changes

- `manager.finish()` previously wrote the terminal task, worker and completion notice separately. `manager-outbox.mjs` now commits those records, related pending-request cleanup and durable events in one synchronous SQLite transaction. Event publication occurs after COMMIT. Nested transactions use savepoints. Repeated completions reuse the execution's notice; a newer continuation is fenced by dispatch key and native turn ID. Recovery repairs missing notice links without rolling an archived/newer worker backwards.
- Notice delivery previously stopped at uncertain state. It now reads native evidence using the original `manager-notice:<noticeId>` ID, marks a known receipt delivered, and retains an unknown receipt without resending. A notice is deferred under the bot lock if the main turn, queue, input gate or Plan transition is busy. It cannot race into a steer of the human's active turn. Delivered, task `collectedAt` and future reviewed acceptance remain distinct.
- Native queue auto-advance happened before the bridge's completion callback, while fallback dispatch also waited for workers. New `queue.add` entries are durable bridge-owned `promptQueue` records. Queue acknowledgement, original input/attachment references and operation receipt commit together. Dispatch waits for the main turn and input/uncertainty/pause gates; active workers are no longer a barrier. Native legacy entries remain first and keep their original IDs.
- `plan-lifecycle.mjs` captures the confirmed mode intent at interactive Plan dispatch. Only a successfully completed proposed-plan item, or finalized explicit `proposed_plan` block, consumes that same intent. Checklists, streaming fragments, clarification-only replies, scheduled/worker/notice turns, failures and interruptions do not consume it. A newer explicit mode choice wins, including choosing Plan again. Consumption updates native subsequent-turn settings, then persists default mode and emits a normal bot event; it does not dispatch implementation or any message.
- Scheduled dispatch now writes its stable operation receipt and run state together before the native call. Direct human Send refuses to steer a scheduled or unresolved scheduled execution; the draft remains recoverable and Queue next remains available. This guard does **not** give schedules an independent thread yet.

## Contracts and ownership

Existing RPC names, old-relay response envelopes, downloads, uploads and native history remain unchanged. No frontend/projection/generated-protocol files were edited. `queue.list/add/update` still return the existing queued-submission shape. Additive staged-entry fields include `state`, `revision`, `operationId` and `waitReason` (`main-turn-running`, `needs-input`, `paused`, `delivery-unconfirmed`, `rejected`, `plan-reconciliation`, or null). The UI owner must render these optional wait/error fields to provide the complete product experience; current old controls can still list/edit/delete eligible entries.

New records use existing `records`/`operations` tables, scoped by bot and native thread:

| Record | Durable identity / role |
| --- | --- |
| `managerTask` additions | `dispatchOperationId`, `executionId`, `completionNoticeId`, native reconciliation cursor/time |
| `managerNotice` additions | Stable delivery `operationId`, source `{kind, taskId, workerId, executionId, turnId, outcome}`, delivery turn and reconciliation time |
| `promptQueue` | Queue ID is the accepted operation ID; dispatch ID is `queue-start:sha256(botId:id:revision)`, also used as native client message ID |
| `planExecution` | Dispatch ID, captured `intentId`, native turn, state, stable `resetOperationId`, evidence/reconciliation times |
| `planTurnEvidence` | Only completed/proposed flags, native status and error metadata; no assistant text/reasoning copy |
| `run` additions | Stable `schedule:<runId>` operation, `threadId`, `executionLane: main-legacy`, cursor/time |
| `runTurn` | A scheduled-context manager-notice continuation keyed by its own operation ID; preserves the original run's turn ID |

The current bridge is scoped to its configured authenticated owner; records retain `botId`/thread/source ownership. Future todo/Operator intake must establish the caller's authorized owner and target before entering this layer, preserve its source request ID and attach references, never accept an arbitrary native thread ID from a client. No todo/phone product APIs were added.

## Recovery and ordering review

These are source-path traces, **not executed fault-injection tests**:

| Boundary / race | Implemented branch |
| --- | --- |
| Crash before terminal transaction commits | Task/worker/notice/events all roll back; native completion can be reconciled again. |
| Commit succeeds, event publication fails | Persisted state survives; operation-done/Plan-consumed guards do not downgrade it. Durable replay and snapshots remain available. |
| Native send commits, reply is lost | Original operation/client ID is retained; bounded exact-ID native lookup, no new send. A missing page is never proof of rejection. |
| Native terminal notification precedes ACK | Task/turn fences and retained terminal metadata prevent the ACK restoring running state; scheduled continuation attribution uses its own operation/turn. |
| Queue edit after proven rejection | New revision gets a new dispatch identity. Uncertain/dispatching entries cannot be edited, deleted or resumed into a second execution. |
| Plan completes while new explicit mode choice is saving | Bot lock plus mode-intent compare-and-set protects the newer choice. A later unconfirmed settings operation blocks consumption instead of overwriting it. |
| Completion lacks proposed-plan item evidence | Next-turn barrier remains until bounded full-item native evidence resolves it. It is not treated as a completed clarification prematurely. |
| Plan completion, then next staged prompt | Native default-settings ACK and durable mode consumption precede the next dispatch. Existing native queue cannot be safely paused, so new Plan enable/start requires that queue to drain. |
| Reset reply lost or restart in `resetting` | Retain `resetOperationId`, mark uncertain, hold settings/new turns; never infer success from bot snapshot equality or repeat the mutation blindly. |
| Old terminal task missing outbox link | Repair reuses a matching legacy notice or creates the execution-specific notice, preserving original task timestamps and newer worker ownership. |

Native reconciliation reads at most four pages of 25 full-item turns per receipt, persists the next cursor, and validates cursor progress. Normal cycles admit at most two receipts per category (Plan, staged queue, schedule, worker, notice), with 30s notice/queue and 60s Plan/run/worker backoff. Startup permits up to 100 Plan/worker receipts. Long tools are not failed merely because of elapsed time. Existing native RPC timeouts can still delay these sequential reads; global fair scheduling/resource telemetry is not implemented here. Main queue dispatch uses the existing five-second runtime tick.

## Migration and compatibility requirements

- Additive records only; no schema/table replacement, file-byte deletion, history deletion, or destructive migration. Original uploads and cancelled/failed staged inputs remain stored. Existing durable operation fingerprints remain authoritative.
- Legacy native queue entries are listed and serviced first. Mixed reorder cannot move a staged entry ahead of legacy entries. No drain/delete/reinsert migration is attempted: that would risk duplicate dispatch. Native entries retain their existing automatic behavior; the bridge cannot retrofit pause semantics into the checked-in v2 queue API.
- Plan consumption is prospective. An already-active pre-upgrade Plan turn has no captured intent and is not guessed retroactively. Manager release should use the existing strict-idle checkpoint procedure and inspect/drain legacy native queue entries before relying on the new Plan guarantee. No live inspection/drain was performed by this worker.
- Legacy held notices remain held unless their already-existing operation proves delivery. Old uncertain notices with no operation record remain uncertain. Proven rejections are visible for review; they are not automatically reissued under a fresh ID. Existing notice text and IDs are preserved when the migration can identify the same completion.
- Downgrading the bridge after accepting staged entries is operationally unsafe: the old bridge will ignore `promptQueue`/Plan receipts. Preserve the DB and run a compatible bridge or explicitly reconcile/export those records before rollback. Frontend/relay publication is not required for the existing RPC envelopes; a manager-coordinated bridge reload is required for runtime changes.

## Exact remaining architecture work

**Independent scheduled/background execution is deferred.** The native protocol can use separate threads, but safe adoption also requires tool routing, notification ownership, artifact/history routing and lifecycle recovery. Merely starting a second thread would drop current handlers that map only `bot.threadId` or manager-worker threads. This pass keeps `main-legacy` explicit and rejects accidental human steering; a human currently must wait or use Queue next while that scheduled main turn is active.

The next pass should implement these coordinated interfaces:

1. A bot-owned durable `executionLane` registry `{id, botId, kind: background, threadId, creationOperationId, state}`. Reserve before `thread/start`; recover uncertain creation by exact lane provenance, never make a second thread because a read failed. Preserve existing main/run threads as `main-legacy`.
2. A shared resolved execution context `{botId, laneId, threadId, runId?, taskId?, operationId, source}` for notification/request/dynamic-tool routing and native reads. Main bot `activeTurnId` must only describe main conversation activity. Pending requests, artifacts, publication paths and owner checks must use that context rather than guessing from the latest active run.
3. Route `schedule:<runId>` dispatches through that lane with the same durable receipt/reconciliation branches added here. Serialize one active run per lane; ordinary human Send always targets main. Selected task/run replies use a separate durable intake `{id, sourceRequestId, botId, target:{kind,id}, operationId, state, nativeReceipt}` and explicit gates, never steer whichever thread happens to be active.
4. Expose owner/bot-scoped `runs.list` and `runs.history({runId,cursor})` contracts plus correlated actionable finding/result receipts. Conversation projection should use native `turnTrigger`, existing `run.turnId` and `runTurn` provenance for legacy history; only deliberately delivered findings belong in main conversation. The conversation owner owns projection, paging budgets, read anchors and UI.
5. Add reviewed acceptance/dependency gates separately from native completion/collection; add compatible-notice batching without losing per-notice delivery identity. Current dependencies still require execution completion only. Later todo/Operator intake reuses these records and authorization checks, not a parallel send queue.

**Unknown Plan reset recovery needs native support or an explicit operator workflow.** Checked-in `thread/settings/update` returns an empty ACK and accepts no idempotency key; `thread/read` does not expose a settings-operation receipt. A lost ACK cannot be automatically resolved safely from matching settings. This pass deliberately holds it, with an error. A future native operation-status/idempotency contract, or carefully reviewed idle-process terminal recovery UI, is needed for self-service recovery. A proven native reset rejection can instead be superseded by an explicit mode choice, then queue resume. No unsafe automatic repair is claimed.

## Verification actually performed

- Read the approved architecture/preferences plans, manager instructions, native generated Turn/ThreadItem/settings/queue contracts and current runtime/manager/store paths.
- Source review of transaction rollback/publication ordering, late terminal ACKs, native queue timing, intent generations, owner/turn matching, legacy records and receipt retention.
- Scoped ESLint on all eight changed backend modules: passed.
- `npx tsc --noEmit`: passed. This checks the app's typed contracts; it does not type-prove these `.mjs` runtime transitions.
- `npm run build`: passed. Vinext reported its existing unknown-route static-classification notices. The application build does not package/exercise the separate bot service.
- `git diff --check`: passed.

Per instruction, no automated tests, suites, diagnostic executions, real native mutations, UI/browser session access, service restart, merge, push or deployment were performed. Crash/power-loss behavior, real native queue timing, network recovery, connected-client rendering and physical iPhone/Safari are unverified here. Independent source review and the manager's release safeguards remain required; no shipped or perfection claim is made.
