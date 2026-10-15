# Testing

```bash
npm run test:all      # build, then both suites; non-zero exit on any failure
npm run test:suites   # both suites without rebuilding (needs an existing dist/)
npx tsc --noEmit
```

`test:suites` runs `node --test tests/*.test.mjs bot-bridge/*.test.mjs`. Two tests
(`tests/recurring-tasks.test.mjs`, `tests/service-worker-cache.test.mjs`) read `dist/`,
so run `npm run build` (or `test:all`) at least once. On Node 24, `node --test tests/`
(a bare directory) does not work; use the globs.

Baseline (2026-10-15, from `codex/bots` 742db1e): 555 tests, 531 pass, 0 fail, 24 skipped.
Any failure is a regression. Do not add a skip without a row below.

## Skipped tests

Kinds:
- **retired**: the feature was deliberately removed; the test can be deleted once its owner agrees.
- **redesign**: the code was deliberately redesigned and the test models the old protocol; it needs rewriting against the new design.
- **check**: as **redesign**, but the new behaviour may be a regression. See "Possible bugs" below.

| Test | File | Kind | Reason / pointer |
|---|---|---|---|
| primary navigation links Chat | tests/rendered-html.test.mjs | retired | Chat nav item replaced by Bots; c05843f |
| ships the browser Talk chat workspace, threads API, and Chat navigation | tests/talk-workspace.test.mjs | retired | browser Talk/Chat workspace, threads API and /talk nav removed; c05843f |
| settings and its crash fallback offer copyable sync diagnostics | tests/sync-diagnostics.test.mjs | retired | copy controls removed from Settings and error fallback; 8609a85, 8b25bc2 |
| settings offers copyable urgent alert diagnostics | tests/urgent-alerts.test.mjs | retired | copy control removed from Settings; 8609a85 |
| queue add/update retain native certainty and same-ID behavior through old relay | tests/bot-relay-envelope-compat.test.mjs | redesign | queue.add/update are local staged-queue mutations, never native `thread/queue/*`; 27e4611 |
| late attachment replay and live metadata update the real timeline without native text hydration | tests/bot-history-metadata-ui.test.mjs | check | timeline refreshes with projection `conversation`, which re-reads a native page and never replays events; f9850af |
| opened tool detail applies ordered deltas, persists completed detail, and validates unchanged versions cheaply | tests/bot-timeline-098e1aae.test.mjs | check | opened details are persisted/revalidated only for conversation items, not tool items; `conversationItem()` in app/bots/timeline-controller.ts, f9850af |
| publication during a native read preserves replay and a text event during detail lookup cannot bless stale text | bot-bridge/history-artifacts.test.mjs | redesign | history.detail reads via two anchored `thread/items/list` calls; the blocking `turns/list` stub no longer models the race; f7f4e98, bot-bridge/history-reads.mjs |
| history cursor hints are verified and cold discovery reads metadata before exact full page | bot-bridge/message-replies.test.mjs | redesign | reply source discovery goes through `historyReads.metadata`; f7f4e98 |
| restart reconciles completed native turns and does not rerun uncertain work | bot-bridge/manager.test.mjs | check | dispatch sets a 60s `reconcileAfter` backoff that `recover()` honours after restart; 25e928d, bot-bridge/manager.mjs |
| queued uploads preserve six localImage paths and reject unready or foreign attachments | bot-bridge/runtime.test.mjs | redesign | queue.add/reorder stage in the local promptQueue; 27e4611, bot-bridge/local-queue-operation.mjs |
| native queue reorders and removes items, then dispatches sequentially across restart | bot-bridge/runtime.test.mjs | redesign | same as above; 27e4611 |
| queued work waits for questions and Stop, and uncertain start reconciles before resume | bot-bridge/runtime.test.mjs | redesign | same as above; also Stop retains unconfirmed executions (execution-stop.mjs) |
| native automatic queue advance keeps the newer turn active | bot-bridge/runtime.test.mjs | redesign | same as above; 27e4611 |
| idle native queue left after bridge restart starts once | bot-bridge/runtime.test.mjs | redesign | same as above; 27e4611 |
| uncertain image enqueue is recovered from native queue after restart without adding twice | bot-bridge/runtime.test.mjs | redesign | same as above; 27e4611 |
| consumed uncertain image enqueue reconciles from the turn; missing evidence never replays | bot-bridge/runtime.test.mjs | redesign | same as above; 27e4611 |
| queue add and queue update propagate certainty at their native mutation boundaries | bot-bridge/runtime.test.mjs | redesign | same as above; 27e4611 |
| async questions persist across turn completion and answer in same thread | bot-bridge/runtime.test.mjs | redesign | waiting status requires confirmed current activity for the question's turn; 358a4e8, bot-bridge/turn-state.mjs |
| native system error contains execution until confirmed current recovery | bot-bridge/runtime.test.mjs | redesign | systemError recovery gates on the latest failed native turn with durable backoff; 1816a6d |
| waiting recovery discards legacy persisted flags on actual runtime restart | bot-bridge/runtime.test.mjs | redesign | restart recovery resolves current activity without a native status read; 1816a6d, dc09532 |
| waiting recovery discards bound persisted flags on actual runtime restart | bot-bridge/runtime.test.mjs | redesign | same as above |
| waiting recovery contains status-only unknown turn until a current native read identifies it | bot-bridge/runtime.test.mjs | redesign | current-activity recovery changed with native error recovery; 1816a6d, dc09532 |
| native definite error is rejected, but post-commit EPIPE/parser/local errors keep the operation ID › `native-definite` subtest | bot-bridge/runtime.test.mjs | check | a definite `turn/start` rejection leaves current activity unresolved, so the corrected send is refused; bot-bridge/turn-state.mjs |

## Possible bugs (found while greening; not fixed)

None was confirmed as a production bug. These need an owner's decision:

1. **Corrected send refused after a definite native rejection** (`bot-bridge/turn-state.mjs`). After `turn/start` is definitively rejected, the user's next send fails with "Current native activity is unresolved…" until reconciliation. Previously the corrected send went through.
2. **Manager tasks can stay "running" for up to 60s after a restart** (`bot-bridge/manager.mjs` around `reconcileTasks`, lines ~1361/~1451). The dispatch-time `reconcileAfter` backoff survives a restart, so a turn that completed while the bridge was down is not reconciled immediately.
3. **Attachment metadata arriving late re-reads a native page** instead of replaying events (f9850af). This is correct but costs an extra native read; verify it was intended.
4. **Opened tool-item detail is no longer persisted/revalidated offline** (f9850af). Only conversation items are; verify it was intended.
5. Minor: the first `item/agentMessage/delta` of a streamed answer finds no timeline entry (empty answers are hidden) and calls `scheduleRefresh()`. That may be one extra `history.view` per new streamed answer (app/bots/timeline-controller.ts).
6. Minor/robustness: `displayReplyItem` / `replyMetadata` (bot-bridge/message-replies.mjs:28) throw when a userMessage lacks a `clientId` key. Protocol-violating input only.
7. Dead code: `buildSyncDiagnosticsReport` is no longer called from `app/`.

## Test-harness pitfalls fixed

- A `BotRuntime` in a test must call `runtime.usage.stop()` before `store.close()`, as `service.mjs` does. Otherwise the usage debounce timer throws "database is not open" after the test, and the whole file fails (often only under full-suite load).
- Code under `app/` uses extensionless TS imports; load it through `tests/helpers/load-ts.mjs`, not a native `import`.
- Native mocks must implement `thread/items/list` (exact item reads since f7f4e98); see `bot-bridge/test-helpers/native-items.mjs`.
