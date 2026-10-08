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

## Bounded admission for future updates

See [MAINTENANCE.md](MAINTENANCE.md) for the new exact-owner operation,
15-minute lease, metadata blockers, original-ID recovery and sealed cutover.
The optional `--maintenance-operation` / `--unit-id` helper arguments require
actual installed `runtimeMaintenance:1` / health metadata. The current old
service cannot be drained by merely writing a lease or running new source:
first installation still needs the original strict-idle guard. Active native
Goals, accepted native queues, volatile sessions and uncertain receipts are
fail-closed blockers; never pause/replay them implicitly. Independent approved
source work no longer waits solely for an unfinished backend activation.

## Completed queue receipts during first installation

An old bridge can retain `native-queued` rows after their exact native inputs
completed, while full history recovery times out. After independent review of
that diagnosis, the release owner may opt into the read-only bootstrap reader:

```sh
python3 -B bot-bridge/restart-when-idle.py --commit COMMIT --version VERSION --reconcile-native-queued
```

Use one new reviewed target receipt/unit under the existing restart authority;
never reuse a claimed or failed attempt, run a competing helper, or revive a
superseded version target. This flag requires a healthy old bridge without
installed admission drain; it cannot be combined with the drain arguments.

Only up to eight positively acknowledged `queue.dispatch` originals qualify.
The reader binds the bot/current thread, revision, original hashed dispatch
client, immutable input fingerprint and native queued receipt. It requires one
indexed **completed** turn whose first canonical user item has that exact
client, and a fully caught-up projection equal to the current owned rollout
file length. It reads fixed private native metadata databases in query-only
mode with bounded queries. Unknown schema, foreign/ambiguous IDs, missing ACK,
unfinished execution, stale projection, active native Goal, any accepted native
queue, unsafe files or concurrent changes stop the helper. Absence alone never
proves completion. Bodies, credentials and transcripts are not returned.

All local active/auxiliary work, other accepted/uncertain receipts, pending
questions, open calls and live secure-input metadata remain blockers. The
helper still checks fresh native current status, source, backup, original
service identity and the exclusive one-restart receipt. It compares the
originals and native database/rollout stamps across the backup, then rechecks
after awaited native status reads and before claiming. The private receipt
retains this proof; journal diagnostics contain counts only. It does **not**
edit either database, mark another bot's queue delivered, replay a notification
or send/start input. The new bridge recovers the retained originals normally
using bounded summary pages, without claiming full Plan-item evidence.

This remains the first-bootstrap strict-idle procedure, not an installed
admission fence or an atomic promise against a human beginning work after the
last observation. RAM-only desktop dialogs/tool activity must already be
settled under the original handoff; this flag does not invent their state from
historical completions. If current idle/volatile state cannot be established,
retain the blocker. Future updates use the installed maintenance drain. Keep
the original rows/bytes and private backup for same-ID recovery; never restore
a backup over newer work merely to repeat activation.
