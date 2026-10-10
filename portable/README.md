# Portable DawarTodo

The single-owner portable gateway passes its preserved owner key to Todo API
authentication. A valid token created for another owner is rejected before
last-used bookkeeping or site forwarding. The existing hosted entrypoint,
without this explicit owner policy, keeps its existing authentication contract.

This is the staging implementation of the approved portable hub and unified
agent migration. Existing Cloudflare production and installed agents continue
to serve until the exact-source migration and activation gates are satisfied.
It is not a completed migration or a supported active-turn restart.

## Roles

The hub owns human authentication, application SQLite, global logical control
and durable delivery. Agents own local Codex stdio, native workspaces/history,
admission and durable native receipts. `both` installs these same two services
on the central machine; it does not create a special local-only agent path.

Node 24 is required. `npm run portable:build` builds a separate Next.js standalone
target and gateway. `npm run build` retains the existing Vinext/Cloudflare target.
Configuration is an absolute owner-only JSON file (version 1). Local services
listen on loopback. Service definitions are installed disabled; installation
never bypasses the original production restart or writer-authority gates.

## Enrollment

Run `node portable/cli.mjs key --data PATH` on the agent. Confirm the displayed
Ed25519 fingerprint through the authenticated hub owner enrollment API, which issues a
five-minute grant. Provision its token in a private local file and run
`node portable/cli.mjs pair --config PATH --token-file PATH`. The node proves
possession with a fresh challenge before the grant is consumed. Native Codex
credentials remain local and are not included in enrollment or hub backups.

The node journal persists incoming commands before acknowledgment. Operation
bindings include original ID, payload fingerprint, owner, bot, node and
placement epoch. Unknown native outcomes are retained; transport retries do
not authorize native replay. Revocation is checked on each live node frame.

The mailbox cursor is persisted on the node. A positive original native
receipt can recover a lost received ACK without resubmitting its input.
Stop stores its hub admission fence in the command transaction; its native
interrupt remains admissible under that fence, while further starts wait.
Frame processing does not wait for slow native acknowledgment. Offline Stop
remains pending until the assigned node returns its actual receipt.

Hub events use a global persisted sequence, independent of each node's native
sequence. Duplicate packets retain the original sequence and are not shown
again. Owner-scoped replay and bounded concurrent snapshots preserve the
existing browser representations. Only observed common capabilities are
advertised; platform capability limits still apply.

## Current unfinished acceptance

Remaining logical controls, full agent runtime/browser routing, local
attachment adapters, voice/provider consolidation, staged data migration,
owner deployment inputs and genuine Mac/device/native acceptance are tracked
in the migration checkpoint. A protocol module or successful build does not
establish production completion.

The registered-file streaming and restic snapshot/isolated-restore modules are
implemented. Disposable protocol and real encrypted local-repository restore
observations are retained in the private migration evidence. This does not
establish an operational S3 backup, scheduled backup, working Mac node or
production write freeze. The latest direct human amendment defers backups for now; retain these modules and evidence for later enablement. Genuine Mac/production acceptance remains unfinished.

Node admission supports assigned explicit turns and the hub's internal saved
queue/schedule commands. Unsupported controls fail closed; there is no agent
queue/schedule tick or second logical scheduler.
Next.js and Sharp security updates are validated before this Node target may
be exposed publicly. The Cloudflare production route remains unchanged.

## Authentication and Mac delivery amendment

Use a dedicated Auth0 Regular Web application with server-side authorization code plus PKCE, an exact issuer, and an explicit stable-subject binding to the retained owner. The client secret stays in an owner-only file, never a frontend bundle. `work.dawar.ca` remains the approved public origin. The Settings machine installer downloads only code and integrity manifests; keys and Codex credentials remain local. Pairing grants expire after five minutes. Installer/service setup does not itself start a native turn.

The portable session uses an HttpOnly session cookie and a separate Secure,
SameSite=Strict CSRF cookie. First-party request factories send that CSRF token;
the gateway requires both its exact session binding and the approved Origin.
The original Cloudflare build keeps its existing authentication behavior.

Run `node portable/agent-package.mjs` after the exact clean portable build to
produce the Settings ZIP download. It includes a platform installer for
Node24 and a pinned, integrity-locked local Codex runtime. The installer copies
only manifest-listed files into a new immutable release, verifies an existing
release without reinstalling dependencies, and never starts a service or bot.
Local credentials and workspaces are not bundled or copied to the hub.

An enrollment timeout retains the original grant/key identity. The installer
first queries signed, fresh, read-only status for that SAME grant and key. A
positive accepted receipt can be recovered even after its grant expires; an
expired unconsumed grant is not renewed. Revocation, changed keys/hello and
foreign identities fail closed. Native execution still requires an explicit
reviewed activation receipt and an approved bot placement.

## Hub-owned logical controls

The authoritative hub reuses original queue/list/schedule/run records, IDs,
revisions and local atomic acceptance closures. Each dispatch commits the
frozen source record and its mailbox command on one SQLite connection. The
hub has no Codex child. Browser command methods cannot select internal queue
or schedule dispatch, and bot tools carry assigned node/bot/epoch provenance;
they are never labelled as human approval.

The same agent checks fresh native current activity, one bounded empty queue
page, Goal state, Stop/control freshness and original file/reply bindings
before it reserves a native attempt. Busy, offline and active-Goal preflight
results retain the received command without starting it. After reservation,
uncertainty retains its original operation. Native admission uses turn/start
with the original client ID and captured settings; it does not install an
automatic native queued prompt that could advance while the hub is offline.

Primary bot queue and schedule tools use the authenticated hub channel. A
disconnect or lost mutation ACK is an uncertain original operation, not an
automatic retry. Bounded read-only node recovery may settle an unknown result
only from an exact original native receipt; an unknown result without that
proof remains contained. Quiet-window and notification schedules are not
inferred from names. The current configured quiet window and explicit
exception IDs govern scheduler eligibility.

Owner queue Send and Resume use the same durable mailbox. Send captures one
saved revision and may steer a positively acknowledged current turn through
the existing native path. A pending or unknown input blocks another Send;
known native acceptance alone does not block deliberate feedback. Resume
checks the completed Stop and current primary activity on the assigned agent,
then records its local acceptance without running a node-local scheduler or
resuming a Goal. The hub release intent is visibly pending until that receipt.
Later Stop revisions supersede either action. Only an exact durable local
Resume receipt can reconcile an ambiguous Resume; no native retry is used.
The low-level Stop endpoint cannot clear Stop and bypass these checks.

This staging step does not complete task/burst transfer,
all room/desktop/voice/browser roles, registered-file transfer or provisioning.
Generic runtime capabilities for unfinished transport consumers are hidden.
The application writer freeze, production authority migration, actual native
activation, genuine Mac enrollment and public rollover remain separate gates.

### Platform file containment

Linux file reads retain the kernel descriptor-path proof. macOS regular-file reads compare the registered canonical path and workspace identity with the already-open descriptor, before and after consuming bounded bytes; changed paths fail without returning or publishing those bytes. These are application guards, not an OS sandbox for existing shell or plugin tools. Source code and workspaces remain local unless explicitly published.

Mac current profile reads use read-only workspace scopes and repeat inode/permission checks. Atomic memory compaction and PDF preview helpers remain unavailable on Mac; no Linux `/proc`, `renameat2`, or `prlimit` fallback is pretended. Their capabilities must stay disabled until a native adapter and genuine Mac behavior are validated. Original profiles, archives and uncertain receipts are retained. This source evidence does not establish physical Mac acceptance.

Agent and full-hub packages include the exact memory atomic helper and bounded artifact preview worker next to their bundled runtime. Inclusion does not enable an unsupported platform capability.

### Assigned-node registered files

The agent's storage adapter uses its authenticated node connection for bounded registration, prepare/finalize, scoped download/preview and read-only task-export metadata. The hub derives bot identity from the canonical registry and checks node/owner/placement epoch before every response and before returning an old success. Paths and legacy machine service credentials are not transmitted. Original metadata operation fingerprints and file catalog identities are durable. Ambiguous replies reconcile the same registered file; they do not recreate a native input.

Upload/download grants are restricted to the same origin, registered object, node/bot/placement epoch and expiry. Revocation, placement changes and the hub write freeze invalidate them; transfers check their grant while streaming. Node uploads additionally bind the original checksum. The existing bounded local publication snapshot and registered-file checksum behavior is retained. General Task Requests and cross-node peer file grants await their canonical addressed authorization adapters; capabilities remain honest. Mac workspace/repositories stay local unless explicitly published.

Both packaged bundles retain the same exact adjacent runtime companion list. The hub uses those immutable files for source guard references; copying them does not start a native process or confer execution authority. Package import/health validation uses disposable data with execution disabled.
