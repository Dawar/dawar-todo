# Central Linux migration handover

The original owner-approved linked continuation remains the sole restart
operation. `--portable-handoff-configuration` and its exact SHA bind a private
release/data configuration to that continuation. They cannot be used in the
ordinary restart or first-attempt modes.

After current native, Goal, queue, tool, unknown-effect and volatile-work proof,
the original helper takes a private backup and stages new hub/agent databases
from that backup. Original receipts and Stop/settings are retained. Application
data and registered files use the completed private copy. The owner accepts
small differences in recent chat/application tails; this does not authorize
replaying uncertain external effects or killing current work.

The central machine enrolls one locally generated Ed25519 key using the same
five-minute, one-use grant and fresh challenge proof as remote machines. Each
existing bot is placed once on that node. Workspaces and Codex credentials
stay local. The central transport uses fixed loopback with the same signed
protocol; remote nodes use TLS. Codex app-server remains local stdio.

All proofs are repeated after staging. Only after the exclusive original
restart receipt is fsynced does the helper install an owner-only drop-in on
the existing unit, disable automatic restart, and recheck current proof. ONE
restart replaces the old service with a combined site/hub/agent supervisor.
The old service and the new logical scheduler cannot run together in that
unit. Health requires the exact source, new invocation/PID, native version,
authenticated central connection, site, maintenance instance and node ID.

This is still the explicitly approved **UNSEALED** first handoff. Existing
async question answers can race until the old service stops; the owner must
avoid answering them during the bounded cutover. A claim or changed drop-in
after failure is retained. There is no automatic retry, claim reset, second
helper or automatic database restore.

Before public rollover retire the old Sites application writer and scheduled
entrypoints using `MIGRATION_SOURCE_RETIRED=portable-rollover-v1`. Its data and
receipt tables remain available privately for recovery. Roll over the public
Tunnel only with healthy actual local services. Verify authentication, original
Todo API scopes, history, registered files and voice/provider routing separately.
Do not infer their success from the restart receipt.

The standalone package generates its own exact-source `/pwa-build.json` and
fresh shell generation. The existing update UI can compare loaded and cached
builds; no forced navigation, private-input clearing or IDB reset is added.
Original hosted login cookies do not authenticate the new Auth0 gateway: owner
sign-in and deliberate app adoption remain genuine rollout checks.

The old voice Worker uses `VOICE_PORTABLE_PROXY=portable-rollover-v1` only at
rollover. It forwards the three existing provider/health paths to fixed
`https://work.dawar.ca/api/voice/...` endpoints and stops its minute scheduler.
It cannot select another host or execute its old call controllers in this mode.
This compatibility URL preserves existing provider configuration; all voice
state, provider processing and minute scheduling belong to the portable hub.

Recovery after post-cutover input must preserve the new databases, mailbox,
journal and uncertain original receipts. Freeze the new authoritative writer
before any recovery route change. Never overwrite new input with the old backup.
Restic/S3 backups and all Mac testing/desktop acceptance are deferred by the
owner; source packaging and installer download remain included.
