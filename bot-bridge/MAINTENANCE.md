# Bounded runtime maintenance

This is an admission drain, not active-turn suspension. The shared app-server
is a stdio child of the bridge; `Codex.close()` sends SIGTERM and systemd uses
`KillMode=control-group`. Starting a replacement does not transparently resume
an interrupted tool/effect. Rolling two bridges against the same thread/store
would also duplicate timers, receipt owners and native admissions. A separate
long-lived daemon would require a separately reviewed transport/lifecycle
migration. Neither is implemented here.

## Owner boundary and lifecycle

The fixed `/runtime/maintenance` endpoint exists only on the existing 0600
local manager socket. It requires the existing private service MACHINE
credential; bot MCP tokens and browser RPC cannot invoke it. The activation
helper reads that credential internally from the current systemd-owned service
process. Never copy it into commands, prompts, logs or profiles. The existing shared Linux account remains trusted; this is application route
authentication, not OS process isolation. There is no maintenance bot tool, arbitrary RPC/path, access grant or bot-supplied approval.
Dwight applies the original genuine human maintenance approval and runs the
reviewed helper; this does not authorize other live mutations as checks.

Every request binds `operationId`, full `commit`, `version`, current bridge
`instanceId`/systemd `invocationId`, original helper `unitId`, and `waitSeconds`.
`action` is one of `begin`, `status`, `observe`, `seal`, `claim`, `cancel`.
`begin` verifies clean exact source and version pin. All later actions retain
the same identity/specification. Metadata and non-secret receipts live in the
existing `runtimeMaintenance` records. A duplicate begin cannot extend expiry;
changed input conflicts. An expired/cancelled/dead-process operation cannot
reopen. This policy does not change peer budgets or previous upgrade receipts.

The drain lasts at most 900 seconds, bounded by both wall and monotonic clocks.
`draining` rejects fresh direct starts before effects; draft contents remain
client-owned. Already durable queue/peer/burst inputs remain intact. New local
queued input can be positively acknowledged, but its native dispatch waits.
Due schedules retain the existing occurrence ID once. No automatic retry under
a new ID, Stop, Goal pause/resume, queue flush or historical replay occurs.
In-flight admission preparations own a scoped permit and can finish; detached
callbacks cannot reuse an expired permit. Central native guards also cover
thread load/resume, creation, compaction, queue add/start and Goal activation.
Legacy worker start paths are fenced too, while their original read/receipt/Stop reconciliation continues.

Existing tools, human Stop/answers and read-only reconciliation remain available
while draining. Canonically validated answers to existing async questions
can continue under a scoped permit; this cannot authorize ordinary fresh input.
Tools/HTTP/secure channels are tracked outside admission locks.
Health and `runtime.info` expose maintenance state; errors explicitly say input
was not submitted. Before the final `sealed`/`claimed` cutover, all admissions,
requests, native RPCs, runtime locks/ticks/history reads, auxiliary work, pending
questions, unknown receipts, desktop sessions/retention, open Operator calls,
volatile secure requests/payloads and buffered relay output must be zero. Close
or finish volatile workflows through their existing authorized controls; never
silently delete payloads or close sessions to make maintenance pass. During the
short sealed cutover new RPC/tool effects are rejected before execution,
including Stop; existing pause/Goal state stays unchanged and the client can
retry after reconnect. No accepted active turn is interrupted by this phase.

`observe` uses only bounded metadata: loaded-session list, nonloading thread
status, Goal state and a one-row accepted native queue query. No thread resume,
start, model inference or whole history is involved. Unknown/malformed/cursor
loops, more than 100 loaded sessions or the 20-second observation budget fail
closed. An active native Goal and any accepted queue remain restart blockers;
this code cannot stop their autonomous execution. Bridge-held pending/unknown
receipts are also blockers. A bounded exact-original exception permits only
the reviewed Connie interrupted intake and Doc/Linus completed nonblocking notices
to remain retained without blocking cutover. Their exact record, bot, thread
and turn identities are bound in the classifier; new terminal-looking rows
still block and require their normal original-ID reconciliation.
This changes maintenance classification only: interrupted work is still
interrupted, a notice stays unanswered and answerable, and no row is settled,
deleted, replayed or converted to a successful effect.

The internal fixed-source reader accepts at most eight retained originals and
16 KiB of body-free identity metadata. It reads the private native index,
queue, Goal and thread-location databases query-only, with a six-second
deadline and no native RPC, transcript scan or credential read. An intake
must bind its exact current bot/thread, original client ID and recorded
terminal turn. A notice must bind its exact async request/item/turn, explicit
`isBlocking:false`, native agent-message question and completed turn. All
indexed turns for those threads must be terminal and their projections must
cover the current owned rollout bytes. Missing, foreign, malformed, active,
blocking, ambiguous or incomplete evidence fails closed. The global native
queue and active/unknown Goal checks remain strict.

The child read is tracked as in-flight work outside admission locks. After it
returns, the original raw rows, all current bot bindings, lease and native
notification generation must still match. Database/WAL and rollout inode,
size and nanosecond modification stamps must remain unchanged. Cached proof
lasts at most five seconds and is revalidated for every count/Seal/Claim.
Other pending inputs, uncertainty, collaboration contexts/resources and all
RAM/tool/work counters still block. This private metadata proof alone never
proves global idle; the existing native observation and all-thread check are
still required. No caller can supply a proof override or native file path.
The existing all-thread strict-idle check is still required. A native event or
concurrent request invalidates safety before seal/claim. Exact source is checked
again. At least 45 seconds of the original lease must remain for handoff. Private
status/claim metadata includes `remainingMs` bounded by the original wall and
monotonic deadline; the helper rechecks that budget after its bounded service-identity read.

Cancel/expiry releases only this fence and retains receipts/inputs/Stop/model
settings. A process crash closes its obsolete fence on next startup, preserving
the original operation for inspection. A claimed restart is never automatically
repeated or reported healthy from the claim alone. Begin lost-ACK recovery reads
the same operation; lost seal/claim/restart ACK retains the original receipt and
requires inspection instead of a new helper identity.

## Activation (Dwight only)

For a bridge without this endpoint, first installation uses the existing
reviewed strict-idle procedure. The `--reconcile-native-queued` bootstrap is
restricted to that pre-maintenance bridge and cannot be combined with a
maintenance operation.

An installed older maintenance-v1 bridge may lack this classifier. Installed
`d0113f9` counts the retained Connie interrupted intake and Doc/Linus nonblocking
notices before Observe proof, so it cannot reach Seal/Claim. Installing source
cannot change that process. Its ordinary drain still admits existing async
question answers. No external proof is an installed seal.

Dawar explicitly approved a **one-time supervised UNSEALED first handoff** in
native user `msg_01a1207c-7861-7100-938e-92dce1a7d634` (October9 11:46:30.625UTC).
The helper verifies that fixed original approval and the exact private healthy
d011 restart receipt, parent/native child identity and binary. This mode is
restricted to that original invocation. Dwight must confirm the agreed human
window: do not answer existing bot questions during cutover. **There remains
an unsealed async-answer last-read-to-restart race.** The helper does not call,
forge, bypass or claim an installed Seal/Claim. This is not an active-turn
restart, a general maintenance exemption, or a new bot/owner RPC.

Dwight alone can run the reviewed target after integrating the exact source:

```sh
python3 -B bot-bridge/restart-when-idle.py --commit FULL_REVIEWED_SHA --version VERSION --maintenance-operation ORIGINAL_OPERATION_ID --unit-id ORIGINAL_UNIT.service --wait-seconds 900 --supervised-d011-once
```

This retains the installed bounded admission drain, all local/native contexts,
Goals/queues, RAM/tool/request/lock/history, call/desktop/secure and unknown
blockers. Only the three fixed originals and the independently reviewed fixed
legacy pre-effect refusals can qualify. Their fresh query-only native evidence
is mandatory. The stale Connie raw hash is not reused: comparison with the
private d011 pre-update backup found only `reconcileAfter` changed, which the
original PrimaryExecution.recover writes before its metadata read. Its exact
input/receipt invariant is bound to that reviewed original; **all current bytes,
including reconcileAfter, are fenced across every cutover read**. Changed
input/receipt, new/foreign/unknown rows or stale projection still block. No
retained record is rewritten, answered, deleted, replayed or reported successful.
The added Linus notice is only `async:call_d097a830dc35437ab45a37c30692bb4e`,
bound to its exact raw SHA-256, bot/thread/turn and current canonical completed
agent-message question proof. The old RAM counters must report exactly one
accepted original and these two pending notices; new, changed, blocking,
active, unknown or stale question evidence still blocks. Full current raw
bytes remain fenced across observation, backup and exclusive restart receipt.

During the bounded **pre-backup wait only**, an observation in which the exact
Connie record changes only its valid, later `reconcileAfter` scheduling timestamp
is discarded and remains busy. The helper logs the fixed record identity, changed
field name, byte counts and before/after hashes, then starts a fresh observation;
it never qualifies that changed observation as idle. Input/receipt/owner changes,
either notice changing, invalid/backward timestamps and unknown records still
refuse. Once an unchanged idle observation is acquired, full raw-byte equality
remains mandatory within and between every backup/final/claim observation.
Diagnostics contain no input, receipt bodies, question text or timestamp values.
The failed65b invocation attempt remains retained; a source correction does not
authorize deleting it, retrying that attempt or launching another restart.

Private backup, repeated native/store/RAM/process/source checks, <=900-second
whole-helper deadline, original lease budget and an exclusive fsynced restart
receipt precede exactly one restart. An exclusive invocation-wide
`supervised-d011-INVOCATION.json` also prevents a different commit/operation
from evading an earlier uncertain attempt; it is never deleted or renewed. No old receipt or backup is overwritten;
post-backup disagreement aborts rather than refreshing proof to force progress.
A final check after receipt fsync blocks new activity before restart. The receipt
explicitly records UNSEALED and the remaining answer race. Before any claim,
failure cancels only this helper's original drain when possible; lost begin ACK
uses the same-ID status and original expiry. A retained claim or restart/health
uncertainty requires inspection, never another helper/restart. Source evidence
is not live installation or genuine concurrency acceptance. The default
Seal/Claim path and pre-maintenance bootstrap remain unchanged.

Do not clear rows, inject events, patch the running bridge, kill active work or
use this option for a different invocation. Keep failed5f/be711d and original9a2
upgrade identities untouched. Independent approved work remains independent.

After actual installed capability/identity/health proof, a later compatible
reviewed update can use ONE named transient unit and stable maintenance identity:

```sh
python3 -B bot-bridge/restart-when-idle.py --commit FULL_REVIEWED_SHA --version VERSION --maintenance-operation ORIGINAL_OPERATION_ID --unit-id ORIGINAL_UNIT.service
```

Keep the exact command/unit/lease/source/receipt in Dwight's checkpoint. The
helper preserves clean-source, all-native/local idle, private SQLite backup,
post-backup fence, exclusive receipt, restart-once and health/version/relay checks.
`drain.json` records the one helper identity; an existing attempt is inspected,
not relaunchable. Failure/deadline cancels the unclaimed fence when possible;
process loss is bounded by lease expiry. A claimed/unknown receipt cannot be
cancelled or blindly repeated. No backup is restored over newer user work.
A blocked drain records aggregate counts/reason, not message content, actor
history, credential or secure payload. Genuine activation/device/native proof
belongs in the release receipt, not in synthetic source observations.

Rollback: revert the source delta before release. Once installed, use the same
safe activation rules; expire/cancel only the original unclaimed fence through
this owner endpoint. Preserve the original records and all newer user data.
