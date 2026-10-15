# Hub/runner cutover runbook

One-time move from the combined backend (`dawar-todo-bots.service`, `run both`)
to a separate hub (`dawar-portable-hub.service`, `run hub`) and runner
(`dawar-todo-bots.service`, `run agent`). Design and role table:
`SPLIT_HUB_RUNNER.md`. Deploy mechanics: `DEPLOY.md`.

**Run this only with Dawar's go.** Nothing in this branch changes a live unit,
config or database until `launch` is run.

## What changes, what does not

- One drained transaction, the same claimed drain as any backend release. It
  waits for bots to be idle and never kills active work. The website, login and
  mailbox are down for about as long as a normal backend release (stop, then
  start until the hub is healthy). This is the last release that takes them
  down for a bot change.
- Files (all listed in the plan, with hashes):
  - `hub.json`: `mode` becomes `hub`; `agentConfigFile` and
    `backendReleaseDirectory` are removed; `teamWorkspaceRoot` is written
    explicitly (it was inherited from the agent's workspaces); source and
    activation move to the target release.
  - `agent.json`: activation moves to the target release; `agent.healthPort`
    (default 47822) is added.
  - `dawar-todo-bots.service.d/90-portable-migration.conf`: target release,
    `run both --config hub.json` becomes `run agent --config agent.json`.
  - **new** `dawar-portable-hub.service` and
    `dawar-portable-hub.service.d/90-portable-release.conf`. The unit has no
    `EnvironmentFile` (no bot or storage secrets); it carries the live values
    of `BOTS_PRIMARY_DESKTOP_BOT_ID`, `BOTS_OPERATOR_ALIASES`,
    `BOTS_PDFTOPPM_PATH` and `NODE_OPTIONS` from the running process. It is
    enabled so it starts at boot.
- No SQLite database moves or changes shape. The hub writer row is frozen and
  flipped to the target source exactly as in a `both` release.
- The front, the tunnel and `dawar-portable-site` keep their units. The site is
  restarted once, as in every hub-writer release.

## Preconditions

1. The target release is installed under `backend-releases/<sha>` and contains
   this branch (`portable/run-hub.mjs`, `portable/run-runner.mjs`, a
   `deploy-cli.mjs` that knows `--role`). **Run the target release's
   `deploy-cli.mjs`**: the live release's CLI has no roles.
   ```bash
   R=~/.local/share/dawar-todo-portable/backend-releases/<sha>
   ```
2. The combined service is healthy and on a release older than the target
   (prepare refuses otherwise).
3. Nothing listens on the runner health port:
   ```bash
   ss -ltn 'sport = :47822'
   ```
   Use `--runner-health-port N` to choose another one.
4. `dawar-portable-hub.service` does not exist yet (prepare refuses if it does).
5. Bots are idle, or will be within the drain window (default 900 s). A
   rehearsal also needs them idle.

## Steps

1. Prepare. The plan is generated from live state and preflighted:
   ```bash
   node $R/portable/deploy-cli.mjs prepare <sha> --role cutover
   ```
   Check in the printed summary: `role: cutover`, `old.source` is the live
   release, `split.hubUnitId` is `dawar-portable-hub.service`,
   `split.runnerHealthPort` is free, `site` is `dawar-portable-site.service`.
   In `plan.private.json`, `files` has five entries; the last two have
   `beforeSHA256: null` (created). Read the `*.prepared` files beside it.
2. Rehearse on copies (temporary units, free ports; production is only read):
   ```bash
   node $R/portable/deploy-cli.mjs rehearse --plan <receipts>/<sha12>-<time>/plan.private.json
   ```
   It must end `healthy`. The rehearsal installs and removes its own
   temporary hub unit.
3. Launch (the controller runs in its own transient unit):
   ```bash
   node $R/portable/deploy-cli.mjs launch --plan <same plan>
   ```
4. Watch the receipt until `outcome` is set:
   ```bash
   jq '{phase,outcome,lastFailure}' <receipt dir>/transaction.json
   ```
   Order after stop: old exit, configs and units written, `daemon-reload`,
   `enable dawar-portable-hub`, site restart, start the hub, wait for hub
   health, start the runner, wait until both are healthy.

## Verify

```bash
systemctl --user status dawar-portable-hub dawar-todo-bots --no-pager
curl -s 127.0.0.1:47821/healthz | jq '{ready,role,source,siteReady,nodes}'
curl -s 127.0.0.1:47822/healthz | jq '{ready,role,source,relayConnected,models}'
systemctl --user is-enabled dawar-portable-hub
```

Expect `role: hub` with the runner's node in `nodes`, and `role: runner` with
`relayConnected: true`. Then sign in on the website and send one message to a
bot.

## Outcomes

- `healthy`: done. Keep the receipt directory; its `backup/` holds the
  pre-cutover configs and databases.
- `rolled-back`: the target was not healthy in its window. The controller
  stopped both new processes, removed the hub unit files, disabled the hub
  unit, restored the three configs, returned the writer to the old source,
  restarted the site and started the combined release. `lastFailure` says
  which check failed. Nothing needs to be cleaned up; a new `prepare` works.
- `expired-before-stop`: bots did not become idle; nothing changed. Retry later.
- `rollback-unhealthy` or `reconciliation-required`: read `lastFailure` and
  `failures`; the service is left running or queued to start. See `DEPLOY.md`.

## Routine releases afterwards

```bash
# Website, login, mailbox, gateway, voice: the runner keeps running.
node $R/portable/deploy-cli.mjs prepare <sha> --role hub
# Bot runtime, Codex/Claude: the website stays up; messages wait in the hub.
node $R/portable/deploy-cli.mjs prepare <sha> --role runner
```

Then `rehearse` and `launch` as usual. A hub release waits for hub writer work
and voice calls to finish, never for bots; it is healthy only when every runner
connected before it has reconnected. A runner release drains native work and
never freezes the hub writer or restarts the site.

The first `--role hub` release is the live proof of the acceptance criterion.
Before launching it, start a long bot turn. Check afterwards that the runner's
`MainPID` is unchanged, the turn finished normally, and a message sent right
after the hub came back was delivered once.

## Reversing a healthy cutover

There is no controller role for this yet (`--role combine` is a follow-up).
Prefer a forward fix with a `hub` or `runner` release. If the combined process
is truly needed again, do it only when the bots are idle, and expect a few
minutes of downtime:

1. Stop the hub (`systemctl --user stop dawar-portable-hub`); its shutdown
   drains voice and exits.
2. Stop the runner. Without a controller claim it refuses SIGTERM and is
   killed after `TimeoutStopSec`, so confirm idleness first
   (`curl -s 127.0.0.1:47822/healthz | jq .maintenance`).
3. Restore `hub.json`, `agent.json` and the bots drop-in from the cutover
   receipt's `backup/configuration-0..2`. Apply the current release to them
   (hub `source`/`activationReceipt`/`backendReleaseDirectory`, agent
   `activationReceipt`, drop-in release path), because the hub writer row now
   names the cutover's target source.
4. `systemctl --user disable dawar-portable-hub`, remove its unit file and
   `.d` directory, `systemctl --user daemon-reload`, restart
   `dawar-portable-site`, start `dawar-todo-bots`.

This path has not been rehearsed.
