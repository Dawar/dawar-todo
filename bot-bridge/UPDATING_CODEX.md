# Updating the Bots Codex runtime

Dawar authorized updates on request and nightly on September 30, 2026.
The nightly check runs at 03:00 America/New_York in Dwight's existing thread.
Existing bot model, reasoning, Fast, pause, draft and history settings stay intact.

## Prepare

1. Reconcile any receipt in `~/.local/share/dawar-todo-bots/runtime-updates/`
   before preparing another upgrade. A claimed restart is never blindly retried.
2. Inspect `codex --version`, `codex update --help`, and the local Bots
   `http://127.0.0.1:47821/healthz`. Run the official `codex update` command
   for the stable installed CLI when a new version is wanted. Do not restart
   the shared Desktop daemon or replace another bot's process as a check.
3. Resolve the installed versioned executable, not a moving launcher. Read its
   `--version`; start an isolated app-server only to initialize and read the
   model catalog. Close this probe without loading threads or sending prompts.
4. Change the single version/package pin in `codex-version.mjs`. An explicit
   `BOTS_CODEX_BINARY` in the service environment must match this version.
5. Generate protocol types with `node bot-bridge/generate-protocol.mjs`.
   Review changes to methods/events/types the bridge consumes. Preserve all
   model roles/settings; catalog appearance alone does not prove inference
   access. Adapt concrete incompatibilities before activation.
6. Run `npx tsc --noEmit`, scoped ESLint/Node syntax checks, `git diff --check`,
   and the production build. Do not run automated suites without user request.
7. Commit and push the reviewed source. A runtime/type-only upgrade needs no
   frontend redeployment: the existing model selector uses the bridge catalog.

## Activate after the current conversation finishes

Use one transient systemd user unit to run the following command from this
repository, with the exact reviewed commit/version:

```sh
python3 -B bot-bridge/restart-when-idle.py --commit COMMIT --version VERSION
```

The helper waits up to 15 minutes for local current work to settle, reads fresh
native status through the existing private local manager credential, backs up
SQLite, checks current work again, claims one receipt, restarts once, and records
the actual ready/relay/version/model result. It never replays an input or alters
historical outcomes. End the current bot turn so it can become idle. If the wait
expires or a read fails, inspect the reason; do not force an active restart.
Keep the unit and receipt paths in a durable checkpoint. Existing user permission
covers this update procedure; do not ask again for routine compatible upgrades.

The helper writes bounded `idle-handoff-wait` journal records when the deferral
reason changes, and `idle-handoff-timeout` with attempt counts and the last
observation. These contain only local active-bot/aux/pending counts, native
status counts when checked, and the before/after-backup phase. Local work skips
native reads; `checked:false` is not native idle proof. No bot/thread identities,
message contents or credentials are logged. Counts describe those observations,
not actors throughout the wait. Inspect them with the original unit invocation;
a timeout without these records cannot retrospectively identify its blocker.
The diagnostics do not relax any idle, source, receipt or backup check and do
not authorize a retry, a manager exemption, Stop/drain or a forced restart.

Inspect the receipt and health after activation. Confirm the new model list
through the PWA's normal reconnect. Do not send a real message or change a bot's
selected model merely to check availability. Report successful catalog exposure
separately from unverified model inference. Keep the previous commit and private
backup available for recovery; do not restore a database over newer user work.

The nightly bot reports actionable failures or important new model availability.
An unchanged check finishes quietly.
