# Portable backend deploy

The backend (hub, website writer, mailbox and bot runner in one process,
`dawar-todo-bots.service`) is replaced by a controller that drains it, stops it
once and starts the new release. Plans are generated from live state; nobody
copies values into a plan by hand.

## Flow

```bash
node portable/deploy-cli.mjs prepare <40-char-sha>
node portable/deploy-cli.mjs rehearse --plan <receipts>/<sha12>-<time>/plan.private.json
node portable/deploy-cli.mjs launch   --plan <same plan>
```

1. **prepare** reads the running service and writes a private plan under
   `<portable root>/deployments/<sha12>-<time>/`. It reads: unit and process
   identity (systemd, `/proc`), the hub config the process actually uses, live
   `/healthz` (source, models), the live hub writer row (`localWriter.expected`),
   the native binary hash, the target manifest hash, and the databases in both
   data directories. It writes the prepared configs: the live hub config, agent
   config and release drop-in with only the release changed. The drop-in also
   gets a finite `TimeoutStopSec` (default 120, `--timeout-stop-sec`). It creates
   target activation receipts derived from the live writer and manifest if they
   do not exist yet. Then it runs preflight. If preflight fails, the receipt
   directory holds `preflight-failure.json`, which lists each field that differs.
2. **preflight** (also run at the start of every `run`) runs the same discovery
   again and requires every plan field to match it. It also checks that each
   prepared file is exactly the live config with the release substituted. A
   stale writer source, a changed config, a different PID or a different model
   list are each refused by field name. A backend unit that another unit pulls in
   (`Wants=`/`Requires=`/`BindsTo=` from e.g. the front) is refused, because
   restarting that unit would start the backend outside the controller. `deploy-cli.mjs preflight --plan …`
   runs it on its own.
3. **rehearse** copies the databases (SQLite online backup; production is only
   read) and the configs to `~/.cache/dawar-rehearsal/r-*`. It starts a
   temporary user unit on free ports and runs prepare plus the full transaction
   there. The result goes to `rehearsal-result.json` in the production receipt
   directory, and the temporary unit and copies are then removed (`--keep`
   keeps them). The unit runs `portable/rehearsal-service.mjs`, a stand-in that
   cannot reach users or bots: it starts no gateway, scheduler, voice, relay,
   Codex or Claude.
   - **Exercised for real:** the plan and preflight, the maintenance drain over
     the copied store, the writer freeze and source flip, backup, the claimed
     shutdown, config swap, start, health, and rollback. It also checks that the
     hub writer and activation agree, and that the release's gateway and agent
     modules load.
   - **Simulated:** native thread idleness, relay readiness and site readiness.

   The copies hold whatever work was in flight when they were taken, and the
   stand-in cannot finish it. Rehearse while the bots are idle. Otherwise the
   rehearsal ends `expired-before-stop`, and its `lastFailure` names the busy
   counters.
   `run` and `launch` refuse a plan that has no healthy rehearsal unless you
   pass `--skip-rehearsal`.
4. **launch** starts `run` in its own transient unit (`controllerUnitId`), so
   the controller survives the service it restarts. The receipt is
   `transaction.json` in the plan's receipt directory.

## Transaction

| Before stop-intent (drain deadline applies) | After stop-intent (forward only) |
| --- | --- |
| hold → observe until idle → freeze writer → backup → seal/claim | wait for old exit (stop window = TimeoutStopSec + 60 s, then **one** SIGKILL escalation) |
| any doubt or the deadline → release the hold, `expired-before-stop` / `blocked-before-stop` | prepare configs + writer source → start → wait healthy (health window, default 300 s) |
| | not healthy, or prepare/start failed → `rollback-intent`: stop the target, restore the before-configs from this operation's backup, return the writer to the old source, restart the site if it was restarted, start the previous release → `rolled-back` |

After stop-intent the controller does not exit while the service is down. A
failed observation is retried within its window. Any unexpected error still
runs `ensure-running` (start, or queue a start behind the stop job). A writer
that does not look like the target while the unit is activating, or during the
first `startupGraceSeconds` (default 30), is treated as pending, not foreign.
Re-running the same plan resumes from the receipt's phase, including an
interrupted rollback. Databases are never restored automatically. The backup
under `backup/` is there for a human decision.

Outcomes: `healthy`, `rolled-back`, `rollback-unhealthy` (previous release
started but not healthy in its window; systemd keeps it running),
`yielded-to-unplanned-start` (another job started the unit after the old exit; the
controller reopened the hub writer for that process and did not stop it),
`expired-before-stop`, `blocked-before-stop`, and `reconciliation-required`
(only if the old process survived stop and SIGKILL, or the controller itself
failed).

## Failures

`lastFailure` is `{step, category, message, beforeStop, released}`. The message
is at most 300 characters, with tokens and secrets removed. `failures` keeps the
last 20 post-stop notes. Maintenance 409 responses from the manager socket
include `reason`, for example "Fresh drained state is not proven", and the
adapter copies it into the message.

## Shutdown

Once the claimed drain proof passes, the backend closes its HTTP and WebSocket
servers without waiting on peers (`portable/close-http.mjs`). Idle and
keep-alive sockets from `dawar-portable-front` are closed, streams and
WebSockets get 2 s, and the rest is destroyed. If close still has not finished
after `DAWAR_SHUTDOWN_CLOSE_MS` (20 s), the process exits.
`tests/portable-shutdown-keepalive.test.mjs` reproduces the 2026-10-14
stop-sigterm hang with the real public front.

The finite `TimeoutStopSec` lives in the release drop-in and only takes effect
from the first deploy made with this flow. That first deploy stops an old
process that still has `TimeoutStopSec=infinity` and the old close code. If it
hangs, the controller escalates once with SIGKILL after the stop window
instead of expiring. With a finite timeout, an unclaimed `systemctl stop` (one
that refuses shutdown) is also killed after `TimeoutStopSec`.

## Drain coverage

The drain's `nativeRpc` count includes in-flight Claude backend requests.
`ProviderRouter.pending` merges Codex and Claude calls, so per-thread work
views see both.

The hub/runner split is designed and staged in `SPLIT_HUB_RUNNER.md`.
