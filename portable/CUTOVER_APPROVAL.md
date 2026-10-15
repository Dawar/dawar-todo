# Hub/runner cutover: steps for approval

What Dawar approves. After this, a website, login or mailbox release
(`--role hub`) no longer stops or drains bots, and a bot release
(`--role runner`) no longer takes the website down. Mechanics:
`CUTOVER_RUNBOOK.md`. Design: `SPLIT_HUB_RUNNER.md`.

Nothing here has been run against production. The only production access so
far was read-only: `systemctl --user cat/show`, `/proc`, `/healthz`, and the
SQLite writer row opened read-only. That access produced the preview below.

## What was checked against the live system (2026-10-15, live 56b60c4)

- `dawar-todo-bots.service` runs `cli.mjs run both --config
  …/codex-recovery-20261012/hub.json` from `backend-releases/56b60c4…`.
  - It has exactly one release drop-in (`90-portable-migration.conf`,
    `TimeoutStopSec=120`).
  - It is pulled in only by `default.target`; `40-reliability-independent.conf`
    resets `Requires=`/`After=`.
  - The Claude settings (`95-claude-bots.conf`), the primary desktop bot
    (`primary-desktop.conf`) and `NODE_OPTIONS` (`91-startup-diagnostics.conf`)
    stay on this unit, which becomes the runner.
- `dawar-portable-hub.service` does not exist. Port 47822 is free.
- The front (`front.json`: listen 3213, upstream 3210, health 47821) uses port
  47821 only for its port-uniqueness check. After the cutover the hub serves
  `/healthz` on 47821, and the front needs no change.
- The tunnel (3212) is independent.
- The site (`dawar-portable-site`, 3211) reads `hub.json` through
  `DAWAR_HUB_CONFIG`, and `mode: hub` is a valid config for it.
- The hub reads its application secrets from `hub.json`
  (`applicationEnvironment`), not from `~/.config/dawar-todo-bots/environment`.
  The generated hub unit therefore has no `EnvironmentFile`; that file's
  secrets (`BOTS_MACHINE_SECRET`, storage, notification) stay with the runner.
- `deploy-cli.mjs preview` ran read-only against live state and passed every
  discovery check a cutover makes. Output:
  `~/.config/Claude/side-session-notes/local_775ce56d…/split-cutover-preview/`.
  It contains the generated hub unit, both drop-ins (prepared and live) and
  the config key changes. It was rendered with placeholder target 20981c9;
  `prepare` regenerates everything for the real target.

**Gap found: web releases are switched separately.** Backend deploys and the
cutover restart the site but never repoint it. It still serves
`web-releases/20981c9…` while the backend is 56b60c4, so the public
`/pwa-build.json` says `20981c9cfdd8`. Browsers get the new client, including
the automatic build reload below, only when the site unit's
`WorkingDirectory`/`ExecStart` names a web release built from this branch. That
switch is the step-0 edit below. It is not part of the controller.

## Step 0: release R (no downtime beyond a normal deploy)

1. Merge `claude/split-cutover-prep` into `codex/bots`. Build and install
   release R: `backend-releases/<R>` and `web-releases/<R>`, the same way as
   56b60c4.
2. Optional but recommended: point `dawar-portable-site` at `web-releases/<R>`
   and restart only the site (a few seconds of website downtime, no bot
   impact). Tabs opened from then on reload by themselves at the next build
   change. Tabs open before that still show the existing "Refresh when ready"
   banner.

## Step 1: cutover (needs Dawar's go)

```bash
R=~/.local/share/dawar-todo-portable/backend-releases/<R full sha>
node $R/portable/deploy-cli.mjs preview <R> --role cutover --out /tmp/cutover-preview   # read-only; review the files
node $R/portable/deploy-cli.mjs prepare <R> --role cutover
node $R/portable/deploy-cli.mjs rehearse --plan <printed plan.private.json>     # must end "healthy"; copies only
node $R/portable/deploy-cli.mjs launch   --plan <same plan>
jq '{phase,outcome,lastFailure}' <receipt dir>/transaction.json                 # until outcome is set
```

Run the target release's `deploy-cli.mjs`. Rehearse and launch while the bots
are idle (the rehearsal copies whatever is in flight and cannot finish it).

## Expected downtime

Measured from today's combined deploys: stop-intent to healthy took 9–10 s
(141fe1c, 20981c9, ad6dc3a, 56b60c4). The one 189 s outlier was 3d0277a,
which still had the old unbounded stop.

| | Cutover (once) | Hub release afterwards | Runner release afterwards |
| --- | --- | --- | --- |
| Wait before anything stops | until bots are idle (today 45 s to 11 min; up to 15 min, then it gives up and changes nothing) | hub writer and voice idle only, normally seconds | until bots are idle |
| Website, login, mailbox down | ~10–15 s (stop, site restart, hub start) | ~5–10 s | **none** |
| Bots unable to run | ~15–25 s (also waits for the runner after the hub) | **none**; the runner keeps its turns, and hub requests in flight end `uncertain` and are not re-sent | ~10 s; messages wait in the hub |

## Verify (2 minutes)

```bash
systemctl --user status dawar-portable-hub dawar-todo-bots --no-pager
curl -s 127.0.0.1:47821/healthz | jq '{ready,role,source,siteReady,nodes}'      # role hub, the runner's node listed
curl -s 127.0.0.1:47822/healthz | jq '{ready,role,source,relayConnected,models}' # role runner, relayConnected true
systemctl --user is-enabled dawar-portable-hub                                   # enabled
```

Then sign in on work.dawar.ca and send one message to a bot.

## Rollback plan

1. **Automatic, during the cutover.** If the hub and runner are not both
   healthy within the health window (300 s), the controller drains and stops
   what it started. It then:
   - removes and disables the hub unit;
   - restores `hub.json`, `agent.json` and the bots drop-in from the receipt's
     `backup/`;
   - returns the hub writer to the old source;
   - restarts the site and starts the combined 56b60c4 release.

   The outcome is `rolled-back`. Expect about the same downtime again. Nothing
   needs cleaning up, and a new `prepare` works.
2. **Before stop.** If bots never become idle, the outcome is
   `expired-before-stop`. Nothing changed, so retry later.
3. **After a healthy cutover (hours or days later).** This is now a controller
   transaction (`--role combine`), rehearsed in tests, not a manual procedure:
   ```bash
   node $R2/portable/deploy-cli.mjs prepare <R2> --role combine
   node $R2/portable/deploy-cli.mjs rehearse --plan <plan>
   node $R2/portable/deploy-cli.mjs launch   --plan <plan>
   ```
   `R2` must be installed and differ from both live halves. Use the
   pre-cutover release (56b60c4) if no database change landed since, otherwise
   a fresh build. The transaction:
   - drains native work on the runner, and the writer and voice on the hub;
   - stops both, disables the hub unit and removes its two files;
   - turns the bots drop-in back into `run both`, `hub.json` back into
     `mode: both` and `agent.json` back to no `healthPort`;
   - restarts the site and starts the combined process on 47821.

   If that is not healthy, it restores the split (hub first, then runner) and
   re-enables the hub unit. Downtime is the same as the cutover. Combine
   refuses if the hub unit has any drop-in besides its release drop-in, or sets
   a gateway variable the bots unit does not have.
4. **Databases are never restored automatically.** Each receipt's `backup/`
   holds online copies, kept for a human decision only.

## Client builds after a deploy

When `/pwa-build.json` names a different build than the running page, the page
reloads by itself (`app/build-reload.ts`). It does this only:

- when the tab is hidden, or the person has been idle for 60 s and is not in a
  text field;
- through `preparePwaRefresh()`, which flushes composer drafts, the capture,
  the task editor and run drafts, refuses while a draft is unsaved or a call is
  live, and has the service worker cache the new document before the reload.

A chunk-load failure (the old build's code is gone) or a screen crash on a
stale build reloads right away, through the same guards. There is at most one
automatic reload per target build per tab session. Visible tabs re-check every
5 minutes.

## After the cutover

Routine releases name their role. `prepare` without `--role` means `both`, and
it refuses on the split installation.

```bash
node $R/portable/deploy-cli.mjs prepare <sha> --role hub      # website/login/mailbox/gateway/voice
node $R/portable/deploy-cli.mjs prepare <sha> --role runner   # bot runtime, Codex/Claude
```

The first `--role hub` release is the live proof: start a long bot turn
first. Afterwards the runner's `MainPID` should be unchanged, the turn should
have finished, and a message sent just after the hub came back should have
been delivered once.
