# Separate the hub from the bot runner: design and staged plan

Status: design only, plus the start-race guards in the deploy controller (see
"Done now"). Nothing here is activated. Source: inventory section 2, "Keep the
website and execution independently available".

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

## Done now (this branch)

- **Start race.** If restarting another unit (for example the front, if it ever
  again has `Wants=`/`Requires=` on the backend) starts the backend before the
  controller does, the previous release starts with the writer still frozen.
  This is now handled in two places:
  - **preflight** refuses a backend unit that any non-target unit pulls in
    (`WantedBy`, `RequiredBy`, `BoundBy`, `RequisiteOf`, `ConsistsOf`), and
    names those units;
  - **the controller**, if a start nonetheless appears after the old exit and
    before its own start, yields (`yielded-to-unplanned-start`): it reopens the
    hub writer for the running previous release, does not stop that process
    (it may already have admitted work), and records why.
- **Stop hang.** `close-http.mjs` and a finite `TimeoutStopSec` (`DEPLOY.md`).

The live units currently show no such dependency: the bots drop-in
`40-reliability-independent.conf` resets `Requires=`/`After=`. The user journal
was not readable from this session, so the reported race was not re-observed;
the guards cover it either way.
