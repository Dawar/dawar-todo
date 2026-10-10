# Portable DawarTodo

The single-owner portable gateway passes its preserved owner key to Todo API
authentication. A valid token created for another owner is rejected before
last-used bookkeeping or site forwarding. The existing hosted entrypoint,
without this explicit owner policy, keeps its existing authentication contract.

This is the staging implementation of the approved portable hub and unified
agent migration. Existing Cloudflare production and installed agents continue
to serve until the exact-source migration and activation gates are satisfied.
It is not a completed migration or a supported active-turn restart.

## Original owner identity readout

`GET /api/migration/identity` reads the configured owner key and opaque user ID
only when the existing authenticated user ID matches it. It rejects Todo bearer
tokens, cross-origin requests and development authentication. Responses are
private and uncached. It never enrolls an identity or reads/writes application
records. Capture the result privately from the original production owner's
session before binding the verified Auth0 subject; a portable staging response
is not evidence of the original site's owner ID. This route must be published
in the original site before it can supply that evidence.

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

## Complete application snapshots

`node portable/cli.mjs export-application --source PRIVATE_SQLITE --destination NEW_PRIVATE_JSONL`
holds one read-only SQLite transaction and streams a versioned snapshot. It
includes every supported application table, original schema, generated-column
definitions, indexes, views, triggers, row identities, autoincrement high-water
marks and database version pragmas. Values are encoded in SQLite before the
JavaScript boundary; signed 64-bit integers, binary, embedded NUL text and real
storage classes retain their original values. Pages are bounded by rows and
estimated bytes, individual records by 4 MiB, and the complete export by 1 GiB.
Unsupported virtual tables and fully shadowed row identities fail explicitly;
limits never silently truncate an export.

`node portable/cli.mjs import-application --source PRIVATE_JSONL --destination NEW_PRIVATE_SQLITE --sha256 EXACT_HASH`
creates a new private database, verifies the complete archive and each restored
table's content digest, and checks SQLite integrity and foreign keys before
commit. Original rows load before triggers, avoiding new synthetic history.
Native SQLite authorization blocks attached databases, temporary stores,
extension loading and unsafe pragmas. Import requires Node24.10 or later in
the Node24 line for `setAuthorizer`; an unsupported build fails before importing. Existing destinations are
never replaced. Neither command changes configured services or starts a
scheduler, agent, provider operation or native turn.

These commands are not an export of the current Cloudflare database. The
internal `withSnapshot` adapter requires a real consistent source for its full
callback. D1 sessions/bookmarks, table counts and paginated dashboard reads do
not establish that guarantee. The original D1 export, registered-file/control
snapshot and cross-service writer fence must be established separately before
production cutover; concurrent local WAL snapshot observations prove only the
local database behavior. Automatic execution remains disabled during staging.

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

### Private original-application capture

The original Site exposes `GET /api/migration/application?recipient=PUBLIC_KEY`
only to its configured original owner through the existing authenticated
session. Todo tokens, development auth, cross-origin requests and untrusted
actor parameters cannot capture data. Identity headers still require the
existing trusted edge; directly exposing the original Worker is not authorized.
The route does not change schema, freeze writers, or create migration records.

Generate a temporary recipient with `snapshot-key --destination NEW_PRIVATE_KEY`
inside an owner-only directory. Retain that key locally with mode0600. Only
its public key is used in the download URL. The downloaded envelope is encrypted
with ephemeral P-256 ECDH and AES-256-GCM. `unseal-application --source SEALED
--key PRIVATE_KEY --destination NEW_JSONL --origin ORIGINAL_HTTPS_ORIGIN` checks
recipient, origin, authenticated ciphertext and full plaintext hash. It never
overwrites an existing destination. Encryption alone does not authenticate the
source: independently verify the original owner-authenticated HTTPS download.

Bounded schema discovery constructs one SQLite statement whose authoritative
schema, sequences and all application rows share a
single read snapshot. Original signed64-bit integers and text/blob bytes are
encoded inside SQLite. `_cf_KV` and `_cf_METADATA` are explicitly excluded as Cloudflare platform
storage; no application table is skipped. The capture refuses unsupported
virtual/shadow tables, unaddressable row identities, schema changes, queries
over100000bytes, tables over1MiB or total row data over8MiB/100000rows. A refusal
never returns a partial snapshot. Larger production data requires a separate
complete export path, not a smaller migration scope.

D1's verified binding does not expose SQLite `user_version` or `application_id`
file-header readers. Its version2 snapshot records both as null with explicit
Cloudflare-D1/unavailable evidence; no application table or row is omitted.
The importer deliberately initializes the NEW local file's two header fields
to zero, verifies that choice, and independently verifies every restored schema,
sequence and row digest. It never claims those zero values came from D1.
Version1 SQLite exports continue to preserve their captured header values.
JSON cell arrays are chunked to respect D1's 32-argument function ceiling.
Column discovery uses documented fixed-name `PRAGMA table_xinfo` statements;
the local Cloudflare authorizer refuses the dynamic table-valued join. The
authoritative capture compares the complete original schema SQL with discovery,
so changed columns cannot silently alter the planned row encoding. This path
uses one discovery request per table plus four fixed requests (up to104 total).
Compound SELECT branches are materialized in groups of at most four terms, within the same
statement/read snapshot, for the tighter local Cloudflare runtime limit.

Use the existing validated `import-application` command to restore the JSONL
into a NEW private inactive SQLite database. Source/fixture success is separate
from actual Cloudflare capture. A point-in-time application copy does not prove
consistent control/files or establish the combined final writer freeze. The
existing production remains authoritative until the full cutover is verified.

### Larger D1 copies during the migration freeze

The private Node `exportFrozenD1Application` adapter reuses the streamed exporter
with D1's explicit version2 header policy. It reads bounded keyset pages rather
than materializing a whole table; table and full-file SHA256, exact schema,
sequences, counts, private permissions and exclusive publication are retained.
The complete copy can exceed the original route's 1MiB/table and 8MiB total
bounds, subject to the existing 1GiB file/4MiB record/10million-row safety limits.
An oversized record, schema/count change, read failure, cancellation or lost
freeze leaves no completed archive and never yields a partial table migration.

Its source connection must supply an authoritative writer-freeze verifier.
The same source/operation/epoch/generation/absolute deadline is checked before
and after every awaited D1 read; draining, outstanding/unknown writers, expiry
or a changed identity are refused. The source adapter must retain the freeze
through the callback and cover ALL original application/provider/file/job
writers. A callback or stable row count alone does not establish that coverage.
The production freeze/owner-authenticated typed transport is not yet connected,
and this API deliberately reports productionWriterFreezeEstablished:false.
No arbitrary-SQL HTTP endpoint, new source credential, source database write,
service activation or CLI production-freeze command is introduced by this module.

### Original D1 database write gate

`d1-write-fence.mjs` prepares a schema-bound plan and installs a fixed before-
INSERT/UPDATE/DELETE trigger for every original user table in one D1 batch.
That batch checks the original schema inside its transaction and rolls back on
any failure. Installation remains open: ordinary rows, existing triggers and
IDs are retained. A deliberate original-ID freeze changes one control row;
SQLite then refuses DML even from an older Worker which lacks request admission.

Installation, freeze and release have immutable payload fingerprints and durable
receipts. Lost ACKs are reconciled from those same records; changed payloads,
replacement operations, concurrent freezes and stale releases fail closed.
Each proof reads schema, gates, control and original receipt in one primary D1
batch. Replica sessions are rejected. Missing or changed guards/schema invalidate
the proof. The deadline is absolute, never renewed under the same operation.
Expiry invalidates the proof and does not silently reopen source writes.

The controller must stop/await its reader and deliberately release the SAME gate
after a failed or abandoned copy, with an authenticated original-ID recovery
path if the controller disappears. An unconfirmed release remains held; it is
never represented as open. A restored inactive target retains the gate and all
receipts until a deliberate target-writer rollover releases that original-bound
copy. No source gate/receipt deletion or prior-data restore is a recovery action.

This gate proves **D1 database writes only**. Its proof scope is
`d1-database-writes`, and the full streamed exporter rejects that scope. The
combined controller still must cover HTTP/background work, scheduled jobs,
voice/provider callbacks, already issued upload policies and native/control/file
activity. The module is not exposed as a public mutation or SQL endpoint and has
not been installed on the production database. Source authentication, the typed
read transport and the combined controller remain required before cutover.

The D1 transaction behavior is documented in the
[Cloudflare binding API](https://developers.cloudflare.com/d1/worker-api/d1-database/).

### Typed source reader

`application-read-source.mjs` accepts only fixed schema/table/sequence metadata
and bounded `sizes`/`rows` commands. Page commands carry a table, exact encoded
order keys and a row limit; SQL and caller-selected column projections are
rejected. Actual columns, row identity and key order come from the held source
schema. The same cell codec is used by Node export/import and the Worker-safe
reader. Int64, text bytes, blobs and native storage classes remain exact.

The Node exporter can use that typed reader instead of a local D1 binding, so a
subsequent encrypted owner-authenticated transport need not expose caller SQL.
Both ends verify the same fresh complete freeze before/after reads. A database-
only gate is insufficient. These are internal modules: no production HTTP
reader, authorization bypass, credential or automatic source freeze is enabled.
The original signed-in-owner transport, combined controller and real complete
copy still require connection and acceptance.
