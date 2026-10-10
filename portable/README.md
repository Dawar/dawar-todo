# Portable DawarTodo

Canonical room lists, bounded posts/results, membership and hold controls use
the hub control store and the original collaboration acceptance closures. Pair
IDs, post IDs, per-recipient delivery IDs and original operation receipts are
preserved. Every member must belong to the authenticated hub owner, including
historical rows returned through bounded pages. Informational posts cause no
model delivery. Addressed posts persist as queued with truthful routing-pending
metadata; native room dispatch/history/questions and captured bot-tool callers
remain unfinished, and the rooms capability stays hidden until that integration
is verified. The hub never runs the local native collaboration scheduler.

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

### Linux private forms

The existing browser encrypted-form channel routes through the authenticated
hub directly to the assigned Linux agent's original `SecureInputs` instance.
Both enrollment and the current node connection must advertise secure transfer.
Owner, browser session, original form/thread, placement epoch and exact node
socket are checked before access and again after asynchronous work. The agent
must have completed startup and received fresh hub controls. Task Request
guest forms use a separate contract and cannot use this channel.

Ciphertext, form keys and transfer results remain in flight; they do not enter
the mailbox, RPC cache, history or event journal. The normal snapshot includes
only scoped form metadata. `secure.list` requires a live capable node and is
not cached. Original volatile credentials, expiration, explicit model-read
choice and same-ciphertext receipt verification stay in the existing agent.
Browser disconnect does not delete a credential or imply submission failure.

Requests have bounded RAM routing (64 hub requests, four per browser, 32 per
agent) and a 15-second response deadline. Unknown delivery is never replayed.
A durable hub work record contains only random lifecycle metadata, never the
form payload. An unconfirmed sent transfer retains an unknown work record and
blocks a later write freeze; neither age nor a retry clears it. Node maintenance
also tracks the actual transfer and original volatile form state. Existing Stop
permits scoped status/deletion while native admission keeps its separate fence.
This source contract is staged; production and genuine owner acceptance are
recorded separately in the migration checkpoint.

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

`context-admission.mjs` attaches the same fresh placement/Stop fence to each
registered named room context. Creating a Linux context requires a captured
original queued delivery; the guard rechecks its exact bytes, placement epoch,
control revision, membership and tools after capacity reads. Anonymous starts
and forks refuse before allocating a native RPC. Bound room turns require the
original dispatch ID and frozen native parameters. Native resume also requires
fresh online control because it can activate Goal/queue work. Read-only history
remains available offline. Synchronized Stop may pause an already admitted Goal
only with the existing exact automatic pause parameters.

A local guard refusal is recorded by in-process identity, never by supplied
`definite`/`not-sent` properties. Only this positive pre-write evidence restores
the same prepared context; native errors/lost creation ACKs retain uncertainty
and never create a replacement. This is an admission component, not installed
room parity: central cross-node room routing, automatic native Goal containment,
consumer wiring and genuine all-context acceptance remain unfinished. No room
or autonomous-Goal capability is advertised by this component.

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

The agent packager checks the current source and compiled agent checksum before
creating its immutable ZIP. The full hub package checks both compiled roles and
the ZIP's source, name, size and checksum before creating a release. Only that
current download is included; earlier release directories and archives remain
outside the new package. A stale build or download is refused, never relabelled
or overwritten. Preparation is not installation or native execution proof.

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

### Encrypted typed read transport

`application-read-transport.mjs` provides the internal POST endpoint lane and
Node/browser client for `/api/migration/application/read`. The complete controller
captures the original owner ID/key, source, capture ID, recipient public key and
immutable freeze epoch/generation/deadline. Each request carries only bounded
typed commands, never SQL, projections, credentials or an alternative source.
Original-owner authorization is supplied by the application's validated session
callback and repeated across awaited reads and encryption; request headers alone
never supply authorization to this module. POST requires the captured HTTPS
origin and rejects cross-site/referer requests, bearer fallback and query inputs.

Every page uses fresh P-256 ECDH/AES-256-GCM. Authenticated data binds the capture,
request ID/sequence, command hash, origin, recipient, full freeze and plaintext
hash. A previously encrypted response cannot serve a different request or freeze.
The existing full-snapshot v1 sealing format is retained. Encryption establishes
integrity and recipient confidentiality, **not source authentication**; the real
owner-session HTTPS route remains an independent acceptance requirement.

There is one active read per lane, with request/response byte bounds of 112 KiB and
6 MiB, thirty-second cancellation signals and fresh complete-freeze checks. Body
cancellation interrupts stalled stream reads. `stopAndWait()` closes new reader
admission and waits for an admitted source read to settle before the controller
may release its gate. A source query that cannot be cancelled must still settle;
an expired timer or closed client does not prove the server query finished. No
silent retry, replacement capture, source freeze/release or production mutation
is performed by the read protocol.

This transport has no connected production route. The real owner callback and
combined authoritative controller must be connected and validated before use.
Local D1/crypto/Request/Response fixtures are separate from genuine owner HTTPS,
global writer exclusion, complete production capture and public rollover proof.

### Original Worker request and job admission

`source-writer-admission.mjs` supplies three retained application/control tables
for cross-isolate admission. Installation, drain and release use exact original
IDs and source/installation/producer fingerprints. A D1 transaction persists each
writer before effects; a concurrent drain rejects new starts atomically, while
already admitted work can finish. The immutable drain deadline is at most 900
seconds. Expiry invalidates proof and keeps new starts held until the original
bound release is confirmed. Lost admission ACK cannot start or replay work;
unknown/active records never become terminal through age or an idle assertion.

`source-writer-scope.mjs` tracks request bodies and nested background factories
through AsyncLocalStorage. Background producers register a thunk before work
begins; a retained closed scope refuses a later factory. Request return alone
does not terminate a stream or child task. A rejected task, uncertain stream or
unqualified socket retains an unknown record. The fixed read-only sync watcher
does not hold a writer solely because its read stream stays open; its prior
authentication/background effects remain tracked. Ordinary platform background
behavior is retained when this temporary admission is disabled.

The original Worker entry covers its HTTP/authentication path and native minute
job before handler effects. Its private `MIGRATION_SOURCE_WRITER_ADMISSION`
configuration must match the actual compiled source and installed producer
fingerprint; no request header selects that configuration. Fixed migration read
handlers keep the real owner authentication boundary and cannot use Todo bearer
tokens. The prepared encrypted reader is still unconnected. Configuration is
absent on production, so these original database helpers are not installed.

The proof scope is `worker-request-and-scheduled-lifetimes`, not the complete
application freeze. Old untracked Worker lifetimes, voice/relay callbacks,
issued storage uploads, native/control/files and unknown provider effects need
separate actual coverage and a pinned environment before the combined controller
may freeze/copy. Helpers remain captured as original rows, with no clearing or
replay used to manufacture idle. Local D1/workerd observations do not establish
global production coverage. AsyncLocalStorage support is documented in the
[Cloudflare runtime API](https://developers.cloudflare.com/workers/runtime-apis/nodejs/asynclocalstorage/).

### Bounded resumable registered uploads

Portable signed upload targets add `resumable: {version: 1, chunkBytes: 4194304}`. Browser task uploads use their existing JSON prepare/finalize endpoints and original `clientUploadId`, rather than sending a whole multipart file through the public API. Bot, ordinary guest and derived-preview uploads consume the same additive target. Legacy provider targets retain their prior single-attempt or replayable caller policy.

The client hashes each four-MiB slice and sends a bounded manifest before transfer; it never materializes a whole large file for this protocol. The manifest, size, optional original whole-file SHA, owner, key, type, bounds and node placement form one immutable session identity. A fresh grant may renew access but cannot change that identity. Every chunk is fsynced before its SQLite receipt; final assembly streams and verifies all chunks before registering the original object ID/hash. One failed response causes a read of the same receipt, not a blind write retry. A changed file, owner, placement, revoked node, held writer, incomplete assembly or unprovable active process remains blocked with local bytes retained.

There are at most eight live sessions, two GiB of reserved original bytes, sixteen receiving chunks and one final assembler. Receivers have a two-minute deadline; grants retain their original fifteen-minute expiry. Staging expires after twenty-four hours. Expired or unprovably busy sessions retain their identity and require original-session reconciliation; never make a replacement attachment merely to escape them. A vanished receiver can be cleaned only after actual process absence; a reused/inaccessible PID stays busy. Completed registration is reconciled from its immutable index and bytes. Completed chunk files are removed, while receipts remain. The journal and private staging directory are hub-local and shared transactionally by local gateway instances.

Four-MiB request bodies preserve the existing 250-MiB video bound without relying on a higher Cloudflare plan. Actual zone overrides and live Tunnel delivery remain deployment acceptance; request size is not a throughput claim. Secure volatile response bodies do not enter this storage path. This prepares final portable hosting, not a complete original-provider write freeze or installed production capability.

### Original-source storage upload transition

New direct-to-provider upload permits would escape request lifetime admission.
The prepared original S3 producer therefore supports a temporary, disabled-by-
default `MIGRATION_STORAGE_UPLOAD_PROXY` configuration containing only its exact
compiled `sourceId` and HTTPS `publicOrigin`. It requires the matching installed
`MIGRATION_SOURCE_WRITER_ADMISSION`; a configured proxy cannot silently fall back
to an external upload when that binding is missing or invalid. This does not
change the portable hub's local registered-object adapter.

This temporary Worker proxy still carries one whole multipart request. It is
not the resumable Node protocol and is not approved for activation while large
file requests could exceed the actual Cloudflare body limit. Legacy provider
permit coverage and a complete writer freeze remain separate prerequisites.

`storage-upload-proxy.mjs` encrypts the original SigV4 POST fields in a bounded,
source/origin/provider-bound AES-GCM capability. The client receives the same
upload target shape, with empty public fields and an opaque same-origin URL.
Both Todo and bot storage use the actual shared S3 producer. Existing attachment,
draft and publication IDs remain unchanged; long-lived provider credentials or
usable direct-provider signing fields are not returned to the browser.

The original Worker admits each upload durably before contacting the fixed
provider. Multipart file bytes stream without buffering the file; the proxy
adds the privately captured signing fields, validates the declared/body bound,
and makes one provider request with no redirects or forwarded cookie, bearer or
identity headers. A completed request-body and exact provider204 are required.
An invalid/expired/foreign capability returns403 before provider effects. Lost,
early or failed provider responses retain an unknown writer through the original
admission scope, with no automatic provider retry. Draining refuses new uses of
already-issued proxy capabilities while admitted uploads finish.

This transition is prepared source, not an installed complete storage freeze.
Previously issued direct-provider policies cannot be revoked by this proxy.
Their actual admitted/uncertain effects must be reconciled separately before the
`issued-storage-uploads` authority can qualify the combined freeze. A signature
expiry or quiet timer alone is insufficient. No current credentials, provider
permissions, upload data, routes or production environment have been changed by
preparing these modules. Ordinary S3 behavior is retained when this feature is
absent; the source-bound installation and old-permit acceptance remain due.

### Complete freeze observation

`application-freeze-controller.mjs` joins the actual primary-D1 admission journal
and database gate with four mandatory, trusted writer adapters: old Worker
lifetimes, voice/provider effects, issued storage uploads and native/control/files.
It captures their exact source, installation, producer, original operation,
generation and common deadline before awaiting any observations. Each adapter
must positively prove held starts, settled work/tools/volatile state and zero
unknowns; a quiet timer, environment assertion or caller-supplied proof is
insufficient. Its hold must remain exclusively releaseable by the captured
controller, with no automatic expiry reopening. Those semantics belong to the
actual adapter and its receipt, not an assertion supplied by a request. No
adapter has a permissive default.

Both database authorities are reread after external awaits. Freshness, original
bindings, wall/monotonic deadline and retained terminal counts remain fenced.
Stopping observation waits for an admitted query; it does not release any gate,
clear history or infer a cancelled query has settled. Original D1/drain releases
remain separate explicit operations after encrypted reader closure.

The controller performs no installation, hold, release, retry or automatic
execution. Its external adapters and real owner HTTPS transport are not yet
connected to production. Fixture observations can validate this composition
without proving those four actual production writer authorities are frozen.

### Portable voice and provider hosting

The gateway can host the original voice relay at `/api/voice/health`,
`/api/voice/openai/webhook`, and `/api/voice/stream`. The existing application
routes continue to validate Twilio callbacks, PINs and one-use bridge tokens.
`voice.enabled` is false by default and requires the exact hub activation
receipt. Provider routes, credentials and production routing are unchanged
until the reviewed rollover. Move the configured relay URL and SIP webhook
only after the original relay has finished its calls and uncertain effects.
Cloudflare deployments retain their original transports through the same
explicit platform functions; no request can select the Node adapter.

Node uses `ws`, the original SIP coordinator, and owner-only `voice.sqlite`.
Only the two existing SIP values are supported, with 1 MiB per value, 64 MiB
aggregate and 1,024 controller identities. SQLite WAL/FULL transactions bind
alarm generations, immutable effect IDs, fingerprints and reviewed source
before each admitted effect. Socket lifetimes, background factories, alarms
and HTTP responses are tracked separately. At most 32 incoming voice requests,
64 resident sockets/requests, 128 background factories, 1 MiB socket frames and
2 MiB outbound buffering are admitted. No-op media heartbeats are not admitted
as background effects. The retained
100,000-effect journal refuses exhaustion instead of deleting uncertainty.

Provider HTTP and WebSockets are restricted to the original OpenAI endpoints;
redirects are refused. Original phone bridge and minute requests go only to
the configured site on loopback with the gateway proof and existing private
bearer, never through a caller-supplied destination. Response bodies are bounded
before HTTP settlement. Journals contain hashes and status, not provider bodies,
tokens or ephemeral keys. SIP call values remain private because the original
coordinator needs their existing tokens; do not publish or copy that database
into normal artifacts. Backups remain deferred by the latest human amendment.

`voice.scheduleMinute` explicitly enables the existing minute producer only
after activation and private secret provisioning. Occurrence IDs persist
before the original scheduled handler runs. There is no replay of missed,
unknown or expired occurrences, or a backward-clock duplicate, and no second scheduler should remain active
after rollover. SIP alarms retain their exact generation and are claimed before
execution. A crashed/ambiguous call or effect stays retained and blocks replay;
the adapter does not reconnect old calls merely because a new process started.

Shutdown holds new voice starts while admitted work finishes. It refuses active
calls, sockets, alarms, unknown effects or unresolved callback faults, and uses
a bounded wall/monotonic deadline. The site is not stopped following a refused
drain. This local barrier is explicitly **unsealed**; it is not the combined
application/control/native freeze, a Cloudflare old-relay observer, an operating
system kill guard or proof of genuine provider/device acceptance. Do not send
service Stop until the complete reviewed handoff is actually satisfied. Source
rollback must preserve the private voice journal and terminal reader semantics.

Voice hosting also requires the actual shared `HubWriteAuthority`. Each short
voice SQLite transaction holds the control writer lock through commit, without
awaiting provider work under that lock. Incoming requests and minute work have
durable local admission records before their effects. An HTTP response or
WebSocket upgrade may return early; the captured original scope remains live
until its sockets, background factories, serialized SIP call and cleanup end.
Existing SIP alarms continue in that exact scope during a hold. Unknown effects
retain a durable unknown admission and their original voice receipt.

Cold persisted calls and alarms without their original live scope remain
blockers. A repeated webhook cannot create a replacement call; exact completed
incoming receipts return their recorded HTTP outcome without redoing provider
acceptance. Closed captured scopes cannot admit late callbacks. These local
records complement the voice idle counts; they do not qualify the existing
Cloudflare relay, old native writer, or the full production handover.

### Original-owner HTTPS application export

`node portable/cli.mjs export-original-application --configuration PRIVATE_PATH`
uses a privately supplied **existing owner's session** and the reviewed typed,
encrypted page protocol. Its configuration has version `1`, kind
`dawar-original-application-export`, the original `capture`, and paths named
`ownerIdentityFile`, `sessionFile`, `recipientFile`, and `destination`. Relative
paths resolve against the configuration directory. All input files are private;
the output is a new private snapshot, with automatic execution disabled.

The session file has version `1`, kind `dawar-original-owner-session`, the exact
`sourceOrigin`, `ownerUserId`, `ownerKey`, `expiresAt`, and a `cookie`. Supply it
privately through an authorized owner workflow; never put it in a command,
repository, chat or log. The tool does not extract desktop cookies, log in,
renew credentials, use Todo tokens or send identity headers. It refuses expired,
changed, foreign, symlinked or non-private session files. Every page first checks
the existing owner-identity endpoint. HTTPS requests use only the two fixed
migration paths, refuse redirects and bound body size, duration and concurrency.
The reader closes and settles actual outstanding reads before releasing itself.

This command does **not** install or begin a writer freeze, release a guard,
retry an uncertain operation, import into production or switch a route. The
original POST read endpoint and all four real external writer adapters still
must be installed and positively verified before a live export. The existing
GET capture is not a substitute for that complete fence. A successful isolated
HTTPS observation is not original-owner authentication or production coverage.

### Canonical portable application and file commits

The Node site and gateway bind their application SQLite and object storage to
the same captured, exact-source hub activation receipt. A missing receipt,
changed writer ID/epoch, closed authority or frozen control row rejects writes.
Reads through LocalD1 and registered-file downloads remain available. Application
schema initialization is a write; prime it before freezing, rather than treating
an uninitialized route's migration/optimization as a harmless read.

Node 24.10+ supplies the SQLite authorizer used here (validated on 24.21).
It rejects mutations before their effect, including RETURNING, CTEs and triggers;
only such a denied write is reprepared under the control DB's BEGIN IMMEDIATE
lock. Application writes/batches use their own transaction and recheck authority
before commit. Read-only calls do not acquire the control write lock. ATTACH,
DETACH, caller transaction control and unsafe connection pragmas are unavailable.
Offline import/fixture LocalD1 instances without a writer are separate from the
production site/gateway factories; they confer no deployment authority.

File put/copy/delete and signed-upload issuance check current write authority.
Canonical file registration, upload acceptance/assembly state commits and
deletion serialize with control freeze changes. Registration rechecks an
existing original row inside its commit, preserving immutable IDs and hashes
when two identical transfers finish. Awaited file reads/copies retain guard
checks; no control lock spans streaming/network work. Hub logical transactions
check authority after acquiring their existing SQLite write lock and before
committing, closing the check-before-lock race.

This is a canonical-commit fence, not a complete all-writer cutover receipt.
Admitted streams, content-file renames, receiving/failed-transfer cleanup and
private upload journals still need the full filesystem drain. Authentication
network exchanges and other awaited work also need that complete
admission coverage. The four old-production external adapters and native Goal,
tool/queue/unknown/volatile-state guards remain mandatory. Do not switch routes,
snapshot live writers, launch a restart or infer idle from these local checks.

### Control and identity commits under the same authority

The actual gateway binds HubStore to its captured writer. Login-state/session
creation and logout, enrollment/challenges/revocation/placement/Stop, mailbox
receipts/events, one-use browser tickets, bounded native-read cache writes and
artifact-operation receipts all use synchronous control transactions under that
authority. A response arriving after freeze cannot create a session, record a
false completed artifact operation or receive a positive node receipt ACK.
Retain the original pending/unknown identity; the failed response is not a retry.

SQLite's authorizer also rejects raw control writes outside their admitted
transaction and cannot modify the authority row through ordinary controls.
Prepared statements are expired at transaction boundaries, including failures,
so a statement compiled under an admitted lock cannot be reused afterward.
Hub logical Store helpers acquire their guarded transaction even when called
without an outer batch; existing nested transactions and after-commit callbacks
are retained. Reads of existing sessions, mailbox state, cached events and
logical records remain possible while held. A new remote read that requires
cache/projection persistence may return a held error; it does not mutate cache.

Schema setup is installation/staging work before these guards are bound; it is
not an authorized live cutover mutation. Runtime guard binding does not create
an OS sandbox or protect an arbitrary separate SQLite connection. Filesystem
streams/private upload cleanup, voice/provider effects and the original native
writer still require their complete admission/drain and cutover evidence.

### Admitted local file lifetimes

The portable gateway and site storage adapter now persist an asynchronous work
record in control SQLite before reading upload bodies, allocating private files,
streaming chunks, assembling/registering files, copying objects or cleaning up.
Nested registered work shares that exact lifetime and is awaited even when its
caller did not await it. Settlement follows awaited file/handle cleanup; a
closed inherited context cannot start another operation or commit a late write.
`settled` means the local lifetime ended, not that a task or business effect
succeeded. Original upload, artifact and operation receipts retain their own
outcomes. A crash retains the active record; no age/PID rule retires it.

The private `LocalWriterDrain` controller binds writer, placement epoch, source
and one original operation/deadline. It holds new file and ordinary control
starts while previously admitted local work can finish. It atomically sets the
canonical frozen flag only after the durable journal has zero active/unknown
work. Failed holds expire visibly and require explicit same-operation release;
they never reopen automatically. Runtime SQLite authorization cannot rewrite
the hold or forge a work settlement. Settlement during a hold can change only
the exact work row, not user data, native receipts or writer authority.

This covers the portable local file and admitted voice lifetimes. It does not
cover old production writers, arbitrary shell/plugin filesystem effects, native
activity, or unowned persisted voice state; the separate voice idle proof still
blocks on those calls and uncertain effects. Paused resumable upload rows and their private parts must be copied
consistently with registered files and the control/artifact databases, retaining
original grants/keys/receipts. The controller does not start services, retry the
failed d011 supervised invocation, replace the native handoff, or authorize a
public rollover. Full original external-adapter and native/voice/volatile-state
proof is still required for migration.

### Original production encrypted-reader routing

The original Worker now routes `/api/migration/application/read` to the real
owner/session validator and the typed encrypted reader. It is disabled unless
the private `MIGRATION_APPLICATION_READ` deployment configuration binds the
exact build, capture, recipient, journal, database gate and all four external
writer authorities. Browser input cannot install, hold, release or assert any
of those controllers. The route has no token or development-auth fallback.

Each configured external producer has a fixed HTTPS observation endpoint and
Ed25519 public key. A fresh nonce, immutable original binding and controller
operation are signed with its fresh held-writer proof. Redirects, substituted
keys, stale/saved proofs, changed source/epoch and missing producers refuse the
capture. These independent reads run together; the D1 journal and database
gate are then rechecked after all await boundaries. Producer bearer credentials
stay in private configuration and never enter the read wire or diagnostic.

The producer adapter accepts an already captured real controller's observation
callback. It does not establish a fence, inspect RAM or infer completed native
work. Production producer installation and native/voice/issued-upload holds
remain separate required actions. No external authority is configured by
default; an unconnected controller still makes the route unavailable. This
source wiring is not a production freeze, exported copy or rollover receipt.
### Existing Linux desktops

Linux execution can enable the existing desktop controller with private
`agent.desktops: { enabled: true, base, launcher, adopt }` configuration. The
paths are absolute node-local paths; `adopt` preserves original slug-to-desktop
names. Copy the original adoption configuration and persistent desktop state
at cutover. Enrollment and each authenticated live node handshake must both
declare this Linux capability. The same agent implements local and remote
Linux execution; Mac desktop remains unavailable and untested.

The authenticated owner browser obtains a 30-second, single-use RAM ticket
bound to its parent connection. The separate viewer connection additionally
binds owner, bot, node, placement epoch and the exact live node socket. Tickets,
passwords, previews and RFB input never enter mailbox/history/cache records.
Node, parent, viewer or scope loss closes the stream without replaying input
or destroying the persistent desktop. Existing browser retention, explicit
exclusive control and screenshot-before-input tool rules are retained.
Desktop starts and new viewers participate in maintenance admission; existing
viewer activity participates in its request/tool accounting. Public adoption
and actual Linux desktop recovery still require genuine cutover verification.

### Installed Linux startup and source identity

The owner-reviewed `portable-agent-activation` receipt must also bind `source`,
`releaseManifestSHA256` and `codexBinarySHA256`. The agent runs from the original
`bot-bridge/portable-agent.mjs` in an installed release. Before opening its local
manager or Codex, it verifies the manifest, every bounded registered release file
and the local native binary. Maintenance repeats this same exact-source check;
it does not require a Git checkout or waive the source/backup/claim fences.
Release and installer manifests remain immutable. Never generate activation
from a manifest merely because it is present: independent review and the real
cutover bind its original hash, node and runtime.

Portable startup initializes the native service/catalog without resuming bot
threads. Original current-state barriers remain. The outbound connection first
synchronizes owner/node placement and Stop; then bounded reconciliation resumes
only currently assigned, unstopped bots. New RPCs/commands are held until local
startup finishes. Commands received during startup are durably retained with
their original IDs/cursors and admitted later from the same `received` record;
`dispatching` and unknown records are never absence-retried. Disconnect, expiry,
Stop and placement changes continue to fence the native RPC itself. Normal
repository bridge startup retains its existing recovery behavior.

### Central human message bursts

Countdowns, typing leases, Pause, Send, Discard and Queue retain their original
message/batch/control IDs in the hub control SQLite. Pause and Queue use the
existing synchronous acceptance/transfer closures: a slow current-work read
cannot delay their durable hold. Typing identity comes from the authenticated
parent browser. Reads and held Queue transfers remain available while the
assigned node is offline; there is no node-local countdown or queue scheduler.

When due, the hub reserves one immutable `portable.burstDispatch` mailbox entry
under the original batch ID, source messages, registered file checksums and
placement/control revision. This reservation is visibly in flight; a later
Pause cannot claim to withdraw a possible native send. The Linux agent verifies
fresh synchronized controls, original thread, local files and quoted references,
then uses the ordinary send/steer boundary with that same native client ID.
Duplicate or uncertain acceptance never starts another send. Exact positive
native reconciliation settles original message parts on both hub and node.
Only an explicit Send after a definite rejection may use the existing derived
superseding batch identity. A local payload reservation failure visibly pauses
the intact input rather than repeatedly retrying it.

Hub snapshots always project authorized placements and implemented capabilities,
even if a browser supplies a bot ID. Burst preferences follow the existing
validated native bot event into the hub. `centralBursts` is currently declared
only by Linux; Mac execution/acceptance remains deferred. This source contract
does not establish production installation, genuine owner/device adoption or
the remaining room/peer and cutover controller contracts.

### Staged registered room delivery

The hub reserves an addressed task/question under its original canonical
delivery ID on the same control transaction as its mailbox and operation.
Only the current signed node connection's `centralRoomDispatch` capability
permits reservation. Quiet posts never reserve a native input. The agent
persists its original attempt before context creation, resume or input and
uses the existing registered named-context producer, eight-slot and per-bot
limits, tool/resource, current Goal, expected-turn and Stop guards.

Immediately before each possible native write, a bounded authenticated
`room-request` verifies the current hub room, immutable post/delivery,
membership, hold, control revision and placement. A stale or unavailable
confirmation prevents admission. Unknown creation/input outcomes retain the
same operation; recovery reads the original native client and input rather
than creating a replacement thread or retrying the send. Positive receipts
project the unique room thread, turn and native terminal outcome back into
the hub; foreground history is separate. `conversations.contexts` reads this
captured metadata through the same owner scope and page budget.

Automatic `centralRoomDispatch` remains **false** in the shipping agent hello,
and `collaborationRooms` stays hidden in browser snapshots until captured
hub tool/result/question/history consumers are paired. Disposable Linux
route observations use a fixture-only positive capability and inert native
boundary; they do not establish installed native, device or production proof.

### Captured registered room tools and useful results

The agent intercepts the existing native `bots_conversations` handler with
its application-captured bot/context/thread/turn. The authenticated
`room-tool-request` broker confirms the assigned node/placement, fresh Stop
revision and original addressed delivery proof before the original central
room acceptance closure. Model arguments cannot assert owner identity.
Authorization precedes recovery of any old successful operation. Posts and
useful results persist only in the canonical hub store; they do not create
a separate local room log or wake the foreground bot.

A tool may arrive before its input ACK. Only positive exact-client evidence
can bind that original live context for tool use. This does not invent a
transport ACK, advance the mailbox or repeat the native input. Later receipts
retain newer context revisions and terminal outcomes. A lost tool ACK retains
the same logical operation and can recover its exact original result; there
is no automatic resend or replacement operation.

Native history/configuration and desktop/workspace/external resource leases
remain on the assigned machine. Fresh central caller/membership/hold/control
authorization precedes the original local guarded operation. No cross-machine
shared-filesystem lock or OS sandbox is implied. Foreground room dispatch,
await/promotion/consumption and synchronous native question answers still await
their paired consumers. Unsupported native operations fail explicitly before
creating local shadow records. Automatic room capability remains disabled.

### Owner room history and asynchronous answers

Owner history, item detail, work log, requested configuration and question
reads are routed to the assigned agent's original registered native context.
The hub captures bot, node, placement epoch, room membership revision, context
and native thread before the read, then rechecks that scope before persistence.
History remains machine-local; matching offline cached pages explicitly retain
their observation age. A cached question cannot authorize a new answer.

Public question catalog reads retain the original question/request identity
and source fingerprint. Secret questions are excluded. An owner answer first
performs a private, live, exact-key lookup on the assigned agent; that internal
lookup is unavailable as a public RPC. Changed, unavailable, foreign or stale
question sources refuse the answer without creating a replacement operation.

For asynchronous questions, the checked source, answer, canonical room post,
delivery and original owner receipt are persisted in the same transaction.
The answer uses the original deterministic question delivery/client ID and
the same registered native producer as ordinary addressed room work. Queueing
is not native acceptance. The original pending question is removed only after
positive matching native acceptance; uncertain receipts retain their IDs and
never retry the input. Owner lost-ACK recovery returns that same original
delivery and rejects changed answer bytes or a replacement operation ID.

Room native terminal events settle the corresponding node journal command.
Context snapshots retain their own current native generation and active turn;
a delayed completion of an older delivery cannot clear a newer active turn.
Synchronous request answers remain explicitly unsupported pending their paired
native response/settlement transport. Automatic room capability remains false
until the remaining foreground, result and other communication consumers are
complete. Disposable Linux/loopback observations are source evidence, not
installed native, owner, device or production acceptance.
