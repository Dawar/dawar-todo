# Separate the hub from the bot runner: design and staged plan

Status: stages 1–4 are implemented and tested behind the existing combined
mode; nothing is activated. Production still runs `run both`, and `--role both`
(the default) is the unchanged transaction. The cutover (stage 4) runs only
with Dawar's go, following `CUTOVER_RUNBOOK.md`. Source: inventory section 2,
"Keep the website and execution independently available".

## Today

`dawar-todo-bots.service` runs `cli.mjs run both` (`portable/run-both.mjs`).
One process holds:

- **gateway / hub** (`dist/portable/gateway.mjs`, port 3210): login, sessions,
  website API and mailbox, voice and the scheduler (`controls.tick`), the hub
  writer (`control.sqlite`, `application.sqlite`, `voice.sqlite`,
  `artifact-index.sqlite`), and browser and node WebSockets;
- **runner** (`runAgent`): `BotRuntime`, the Codex child and the Claude backend,
  `native-control.sqlite`, `node-journal.sqlite`, and the manager socket;
- `/healthz` on 47821, which reports ready only if both halves are ready.

`dawar-portable-front` (public, never restarted by deploys) proxies to 3210, and
`dawar-portable-site` serves the web UI. Every release, even a website-only one,
goes through the runner's native drain and shutdown. That shutdown is where
2026-10-14 hung: the front's keep-alive connections held 3210 open inside the
process being stopped.

## What already separates cleanly

- `cli.mjs run hub` and `cli.mjs run agent` exist, and so do the matching
  `services.mjs` units.
- The runner already reaches the hub over the **remote-node protocol**:
  `centralRouting`, with `loopbackHubPort` set to 3210 and `/nodes/connect`. In
  the combined process the agent is already a WebSocket client of its own
  gateway. It reconnects with backoff, resyncs with its journal cursor, and
  fails unconfirmed hub requests as `uncertain` instead of replaying them.
- The data directories are already separate (`hub/` and `agent/`). **No SQLite
  data needs to move or be converted.**

## Couplings the split must resolve

| Coupling | Where | Resolution |
| --- | --- | --- |
| One source binds both halves: `hub.source` = writer admission source = agent activation source | hub-authority, local-work-admission, activations | Per-role sources: the writer row and hub activation follow the **hub** release; the agent activation follows the **runner** release. Compatibility is the manifest `protocol` (today 1). |
| Gateway reads the agent's `native-control.sqlite` at start (`legacyTeamSource`) | run-both → team-adoption | It is a one-time adoption, guarded by `portable-team-authority` meta, which is already set live. Hub mode omits `legacyTeamSource`. |
| Hub config `mode:'both'`, `agentConfigFile`, `backendReleaseDirectory` (both-only) | config.mjs | `hub.json` becomes `mode:'hub'`; `agent.json` is unchanged (it already names `loopbackHubPort`). |
| `run hub` spawns its own Next site, has no `/healthz`, and uses plain `server.close` | cli.mjs | Honour `externalSite`, serve a hub `/healthz` (writer, voice, scheduler), and close with `close-http.mjs`. |
| One `/healthz` for both halves | run-both | Hub health on 47821 (front-facing readiness); runner health on its own port (`relayConnected` means connected to the hub). |
| The deploy controller drains native work and freezes the hub writer on every release | deployment-linux | Plans get a `role`. **Hub releases:** writer drain/freeze, voice drain, then stop/start only the hub unit; no native drain. **Runner releases:** native maintenance drain only; no writer freeze. |
| The site restart that refreshes the writer source | prepareStart | Only on hub releases. |

## Target topology

```
front (3210 upstream) ──► dawar-portable-hub.service    run hub   (gateway, writer, voice, scheduler)
                              ▲  /nodes/connect (loopback)
dawar-todo-bots.service ──────┘  run agent (runtime, Codex/Claude, manager socket)
```

There is still one scheduler and one durable execution owner. No unit has
`Wants=`, `Requires=` or `BindsTo=` on another, so restarting one never starts
or stops the other (the deploy preflight now enforces this, see below).

## Staged plan

Each stage is deployed with the deploy flow in `DEPLOY.md` (prepare, rehearse,
launch) and can be rolled back on its own.

1. **Hub runner parity (code only, inert).** `run hub` gains `externalSite`,
   hub `/healthz`, a `close-http` shutdown, and no `legacyTeamSource`. Add a
   runner health endpoint to `run agent`. Tests start both entrypoints against
   copies (as the rehearsal does) and show that the runner reconnects after the
   hub restarts.
   *Accept:* the combined `run both` is unchanged; the new paths are only
   exercised by tests and rehearsal.
2. **Prove the acceptance criterion off production.** In a rehearsal-style
   sandbox with a real agent and a fake native backend:
   - restart the hub while a native turn and its tool connection are active;
   - show the turn continues;
   - show new input is accepted durably after reconnect;
   - show events are caught up from the journal cursor;
   - show an in-flight hub request ends `uncertain` and is **not** dispatched
     twice.

   Today a hub restart fails pending `controlPending` requests as `uncertain`.
   This stage decides whether that is acceptable or needs request
   re-attachment by original ID.
   *Accept:* the inventory section 2 criterion, as an automated test.
3. **Role-aware deploy plans.** `prepare --role hub|runner|both` uses
   per-role discovery, drains and health. `both` stays the current
   transaction. *Accept:* e2e tests per role with the fake systemd.
4. **One-time cutover (the only step that touches the native path).** One
   drained `both` transaction with a different start step:
   - stop `dawar-todo-bots` (claimed drain, as now);
   - write `hub.json` as `mode:'hub'` (prepared from live, same rules as the
     release substitution);
   - install `dawar-portable-hub.service`;
   - repoint `dawar-todo-bots` to `run agent`;
   - start the hub, wait for hub health, then start the runner and wait for
     runner health plus `relayConnected`.

   Rollback restores the before-configs, removes the hub unit and starts the
   combined release. No active work is killed: this is the same claimed drain
   as any backend release.
5. **Routine releases afterwards.** Website/control/mailbox changes use
   `--role hub`: front stays up, bots keep running, and the runner reconnects.
   Runner changes use `--role runner`. Codex upgrades stay runner releases with
   a full drain, and no turn is moved between processes.

## Implemented

| Stage | Code | Tests |
| --- | --- | --- |
| 1. Hub runner parity | `run-hub.mjs` (`cli.mjs run hub`): mode `hub` only, honours `externalSite`, no `legacyTeamSource`, hub `/healthz` (writer, voice, site, connected nodes), voice drain then `close-http` shutdown with a bounded backstop. `run-runner.mjs` (`cli.mjs run agent`): the same `runAgent`, runner `/healthz` on `agent.healthPort` (`ready` is the runner's own; `relayConnected` is reported separately, so a hub restart does not make the runner look broken), and the combined claimed-drain shutdown (`combined-shutdown.mjs`, now gateway-optional). `agent-cli.mjs` (remote agents) is unchanged. | `portable-split-entrypoints.test.mjs` |
| 2. Acceptance off production | The hub is replaced (closed and reopened over the same `control.sqlite`) while a native turn runs and its hub tool call is in flight. | `portable-hub-replacement.test.mjs` |
| 3. Role-aware deploy plans | `prepare --role hub\|runner\|both\|cutover`. Per-role discovery, drain, health, rollback and rehearsal (`deploy-plan.mjs`, `deployment-linux.mjs`, `deploy-rehearsal.mjs`, stand-in `run hub\|agent`). | `portable-deploy-roles.test.mjs` (fake systemd, real processes) |
| 4. Cutover | `--role cutover`: one drained transaction from the combined unit to the split topology, with automatic rollback. | same file; procedure in `CUTOVER_RUNBOOK.md` |

### Stage 2 result: in-flight hub requests stay `uncertain`

The test shows, with the shipped `AgentTransport`, journal and native store:

- the native turn keeps running while no hub exists (no interrupt, the runner
  keeps its turn), and it finishes during the outage;
- its completion is journaled on the runner and reaches the new hub from the
  journal cursor (the hub asks for original receipts on reconnect,
  `durableReceiptRecovery`), so the original Send settles `terminal`;
- a hub tool call the old hub committed but never answered ends `uncertain`
  on the runner and is **not** re-sent; a native retry with the same call ID
  (`tool:<callId>`) returns the one committed schedule, and no second one
  exists;
- a dispatch whose native-acceptance receipt died with the old hub reconciles
  by its original operation ID; Codex sees exactly one `turn/start`;
- new input is durably accepted by the new hub and delivered once.

Decision: failing in-flight hub requests as `uncertain` (reads as `not-sent`)
is acceptable; request re-attachment by original ID is not needed. Writes that
carry an operation ID are idempotent at the hub. Residual risk: a hub write
tool called **without** an `operationId` (some `bots_queue`/`bots_message`
operations accept one optionally) that the hub committed just before it was
replaced is reported `uncertain`, and a model that retries it may repeat it.
That is the same behaviour as a network drop today.

The test's node link is in-memory (`tests/helpers/portable-harness.mjs`,
which now mirrors the gateway's receipt-recovery sync); it is protocol-level
proof, not a live restart. The first live proof is the first `--role hub`
release after cutover (see the runbook's verification).

### Roles in the deploy controller

| | `both` (today) | `hub` | `runner` | `cutover` | `combine` |
| --- | --- | --- | --- | --- | --- |
| Unit | `dawar-todo-bots` | `dawar-portable-hub` | `dawar-todo-bots` | `dawar-todo-bots`, installs `dawar-portable-hub` | `dawar-todo-bots`, removes `dawar-portable-hub` |
| Live config | hub.json (`both`) | hub.json (`hub`) | agent.json (from `--config`) | hub.json (`both`) | hub.json (`hub`) and agent.json |
| Drain | native, then hub writer | hub writer and voice only | native only | native, then hub writer | native (runner), then hub writer and voice |
| Writer freeze/flip | yes | yes | **no** | yes | yes |
| Site restart | yes | yes | **no** | yes | yes |
| Files | hub, agent, release drop-in | hub, hub release drop-in | agent, release drop-in | hub → `mode:hub`, agent (+`healthPort`), drop-in → `run agent`; **new** hub unit and its release drop-in | hub → `mode:both`, agent (−`healthPort`), drop-in → `run both`; hub unit and drop-in **removed** (kept in backup) |
| Healthy | combined `/healthz` | hub `/healthz`: ready, site, source, every node connected before is connected again | runner `/healthz`: ready, `relayConnected`, source, runtime, models, native child | both, hub started first | combined `/healthz` on the hub port, hub unit gone |
| Controller lock | `<hub data>/deployments/<unit>` | `<portable root>/deployments/controller` (shared) | same shared lock | as `both` | shared lock |

A hub and a runner release share one controller lock, so they never overlap.
A plan refuses a unit whose live config or health is the other role.

The cutover's hub unit is generated, not copied: no bot or storage secrets.
It carries the live values of the non-secret variables the gateway bundle
reads (`BOTS_PRIMARY_DESKTOP_BOT_ID`, `BOTS_OPERATOR_ALIASES`,
`BOTS_PDFTOPPM_PATH`, `NODE_OPTIONS`; `HUB_ENVIRONMENT` in `deploy-plan.mjs`).
It is enabled (`WantedBy=default.target`) so it starts at boot; rollback
disables and removes it. Files the cutover creates have `beforeSHA256: null`
in the plan; rollback deletes them instead of restoring them.

No SQLite data moves or changes shape. The only migration is configuration
and units, and it is the cutover transaction itself: reviewable as a plan,
rehearsed on copies, and rolled back automatically if the split topology is
not healthy in its window.

## Earlier guards (deploy redesign)

- **Start race.** If restarting another unit (for example the front, if it ever
  again has `Wants=`/`Requires=` on the backend) starts the backend before the
  controller does, the previous release starts with the writer still frozen.
  This is handled in two places:
  - **preflight** refuses a backend unit that any non-target unit pulls in
    (`WantedBy`, `RequiredBy`, `BoundBy`, `RequisiteOf`, `ConsistsOf`), and
    names those units;
  - **the controller**, if a start nonetheless appears after the old exit and
    before its own start, yields (`yielded-to-unplanned-start`): it reopens the
    hub writer for the running previous release, does not stop that process
    (it may already have admitted work), and records why.
- **Stop hang.** `close-http.mjs` and a finite `TimeoutStopSec` (`DEPLOY.md`).

## Not done

- ~~Reversing a healthy cutover~~: done as `--role combine` (a controller
  transaction with rehearsal, tested with the fake systemd including a
  cutover → combine round trip). `deploy-cli.mjs preview` renders any role's
  generated units and drop-ins read-only.
- No live restart of the real gateway with a real runner was run (stage 2 is
  protocol-level); the runbook's first hub release is that proof.
