# Held states: budgets, status, Recover and notices

Held, unresolved and uncertain records fail closed: they refuse input or keep
work waiting until native truth confirms them. That stays. What changes is
that a hold can no longer stay silent. `held-states.mjs` gives every held
record a time and attempt budget. Past the budget:

- the bot's work view carries `held` (label, plain-language reason, last
  error, since, and what is held). Bot details → Overview shows it with a
  Recover button per record, the sidebar row shows the label instead of the
  message preview, and the status line shows it instead of "Checking
  execution";
- Dawar gets a push notification (deduped, see below).

## Inventory and budgets

| Kind | Held when | Since | Budget |
| --- | --- | --- | --- |
| `activity` | `botActivity.unresolved`, or its thread differs from the bot's | `unresolvedSince` (new), else first observation | 15 min or 5 failed checks |
| `native-recovery` | `nativeErrorRecovery` for the current thread, phase not `recovered`/`superseded` | `createdAt` | 15 min or 5 attempts |
| `inbox` | `primaryInbox` `dispatching`/`uncertain`, or `accepted` with a turn that is not the current one and no terminal status | `attemptedAt`/`acceptedAt`/`createdAt` | 15 min |
| `prompt-queue` | `promptQueue` `dispatching`/`uncertain`/`native-queued` | `updatedAt`/`createdAt` | 15 min |
| `run` | legacy-lane `run` `starting`/`uncertain` | `startedAt`/`scheduledAt` | 15 min |
| `burst` | `messageBurst` `preparing`/`dispatching` | `updatedAt`/`createdAt` | 15 min |
| `collaboration` | `managerOperation`, `managerExecution`, `answerExecution`, `runIntake` `dispatching`/`uncertain` | `updatedAt`/`createdAt` | 30 min |
| `maintenance` | runtime maintenance is holding | lease `createdAt` | 30 min (drain itself is bounded at 15) |

Not holds: accepted work on the current turn (working), accepted work without
a turn (waiting in line), running runs. "Since" is the earlier of the record's
own timestamp and the watch's first observation (`heldObservation`).

Initiative skips are hub-side (`initiativeBot.lastSkip`); they are not in this
node-side inventory. See the follow-up note in the hand-over.

## Recover (`held.recover`, owner browser only)

Offered for `activity`, `native-recovery`, `inbox`, `prompt-queue` and `run`.
It runs under the bot lock and only uses the existing read-only reconcilers:

1. Dead process-epoch artifacts are marked superseded. A native retry whose
   `nativeRetryEpoch` is not this runtime's epoch belonged to a replaced Codex
   process and will never report (phase `superseded`, evidence recorded). A
   `nativeRecoveryAction` still `dispatching`/`uncertain` from another epoch
   and another native process becomes `connection-ended`, outcome kept
   `uncertain`. This is the Oct 15 Connie repair, generalized.
2. Backoff timers for the record are cleared and the record is re-derived:
   `activity`/`native-recovery` → `reconcileCurrentActivity` (thread/read +
   thread/turns/list); `inbox` → `PrimaryExecution.recover` (exact turn/client
   ID, native queue list); `prompt-queue` → `reconcilePrompt`; `run` →
   `reconcileScheduled`.

None of these submit, steer or re-queue input. Repeating Recover is harmless:
a settled record returns `resolved: true` without further reads. Burst,
collaboration and maintenance holds have no automatic recovery; Recover refuses
them definitively and changes nothing.

## Notifications

`HeldStateWatch.tick` runs every 30 s from `runtime.tick` (legacy bridge) and
`AgentTransport.recover` (portable runner). It notifies once per newly
escalated held record and at most once per bot per hour (`heldEscalation`). A
record that resolves and is held again inside that hour waits. A runtime-wide
maintenance hold notifies through one bot only.

Delivery: the legacy bridge flushes `notice` rows to `/api/bots/notifications`.
The portable runner previously never delivered them (none reached the push
outbox after the Oct 10 cutover). It now hands each notice to its hub as a
journaled `notice` event; the hub stores it once in `todo_bot_notifications`
(`portable/hub-notices.mjs`) and the minute job sends Web Push. A notice for a
bot without a node control stays undelivered locally.
