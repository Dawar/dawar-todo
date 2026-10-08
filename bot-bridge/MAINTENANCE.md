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
receipts are also blockers, even if a historical index suggests completion.
Original-ID reconciliation must establish their current status separately.
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

The currently running old bridge does **not** have this endpoint. First
installation therefore still uses the unchanged strict-idle procedure. Do not
pretend this source's admission fence is installed or kill active work to
bootstrap it. Independent source/front-end work can proceed while activation
is pending. Keep the failed5f/be711d unit/empty target and original9a2 upgrade
identities; do not rerun them as a maintenance-process test.

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
