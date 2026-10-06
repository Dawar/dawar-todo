# Recoverable peer discussion policy

Version 1 replaces the lifetime twelve-round denial. A root is one correlated
named-bot discussion; it is never a new permission grant or a new native thread.
Existing native caller, ownership, Stop, goal and uncertain-delivery authority
remains in force. Owner controls use the authenticated browser relay. The bot
MCP/native-tool routes cannot invoke them; caller identity cannot come from params.

## Defaults and measured units

Each owner grant allows **24 charged contributions** and **512 KiB UTF-8 selected
text**. A new request and every additional reply after its first each charge one
contribution. First replies and cancellations remain reserved receipts, but their
actual text/exchange usage is still recorded. A third identical selected-text
hash in the same sender/recipient direction and exchange kind within the last
8 exchanges pauses the root. Reaching 32 exchanges in 60 seconds also pauses it.
No timer, bot prose, new turn or service restart replenishes an allowance.

The selected pre-change fanout audit had 12 requests, 9 participants, 21 exchanges
and 50,856 selected-text bytes; a separate operational root had 11 requests,
3 participants, 22 exchanges and 51,519 bytes. These defaults leave room for such
ordinary fanout and replies, while bounding additional work. They measure traffic,
not tokens, dollars, useful progress or actual native execution cost.

Lifetime counts remain history. Exceeding an allowance holds the original operation
and selected input before new peer acceptance. The same operation can be explicitly
retried after owner Continue; it never dispatches itself. Existing local queued
intakes for that root remain frozen until Continue. Reserved first replies and
cancellation receipts can still be stored/read, with their automatic intake held.
Already committed native queues, uncertain outcomes and current turns remain
reconcilable; discussion Stop does **not** retract or interrupt them. Per-bot Stop
and paused goals are separate controls and are never cleared by discussion Continue.

## Root and owner control

`peers.root({rootId})` returns `root`: version/revision/state, reason and explanation,
current allowance usage, lifetime usage, limits, up to 64 participant IDs with exact
participantCount/participantsComplete, reserved first replies,
queued/committed intake and held-operation counts, owner controls and observation sequence. Policy
revision fences admissions/grants/stops; observation sequence separately describes
runtime metadata. Intake counts are receipts, not a claim that a bot is currently
working. Existing request `executions` uses exact current native evidence.

`peers.control({rootId, action: 'continue'|'stop', expectedRevision}, operationId)`
is owner-only. Continue is allowed only when held/stopped, grants one fresh allowance
on the **same root**, and leaves per-bot Stop/goals alone. Stop only fences discussion
admission. Result has `root`, `previous` allowance/state/revision and `control` with
exact operation/root/bot/action/expected/applied revisions, scope and
`nativeInterruption:false`. The operation journal retains each previous allowance.
Duplicates return that original receipt even when current root metadata has advanced;
a conflicting revision has no effect. Unknown ACK: repeat the exact retained
operation/params/ID, then read current root; never create a replacement grant.

All old roots already at twelve migrate to `paused/legacy-limit`, retaining original
counts, files and intake/request/exchange/operation IDs. No automatic reopening,
replay or cancellation occurs. Migration is idempotent metadata in existing SQLite
records, with no new schema or cloud configuration.

## Bounded read contracts

`peers.read({id,cursor?,limit?})` keeps legacy `request`/`exchanges` keys and adds
`nextCursor`, `bodyBytes`, `pageLimit`. Maximum 12 exchanges and 256 KiB serialized
exchange body per page; cursor binds bot, request and a frozen high-water row.
Read next pages progressively without removing earlier rows/reading anchors.
A new refresh discovers later arrivals. Requests/list/status/events have `result:null`
and `hasResult`; final text lives in the exchange, not repeated metadata.

`peers.status({cursor?,limit?})` returns at most 12 active/held/committed or paused-root
representative requests, plus exact visible/open/paused/stopped totals and nextCursor.
Use this instead of exhausting all historical `peers.list` pages on each mount.
A partial page is not deletion evidence for unseen cached rows.

`peers.feed({cursor?,after?,limit?})` returns at most 12 **body-free** exchange metadata
rows across this bot's owned requests, chronological within each page. Initial view
is newest page (`direction:'older'`); nextCursor reaches earlier pages. Reconnect
uses `after` with the prior highWater (`direction:'newer'`) and progresses through
nextCursor until complete. Each cursor freezes its highWater and binds bot/direction.
Only a completed newer traversal advances a reconnect highWater; partial pages do
not prove absence. `arrivalSequence` is immutable SQLite acceptance order, separate
from round numbers, timestamps and mutable delivery state.

Metadata preserves exchange/request/root, exact author/recipient, selected-bot file
references, intakeAlias (request.id initially, exchange.id for later reply/cancel)
and nullable retained intake/current thread/native turn/queue/client aliases. A
missing historical intake is `null`, never invented current activity. Exact same
aliases deduplicate native wrappers/cache/live/feed/history. Files are references;
no feed/read operation copies or implicitly shares them.

`peers.held({rootId?,cursor?,limit?})` reads ONLY the selected bot's retained
unaccepted peer inputs (12 rows/256 KiB maximum), including their original params
and operation IDs for deliberate same-ID retry under fresh current caller authority.
Continue never replays these expired caller operations itself. It permits original
already-admitted queued intake to proceed, subject to existing per-bot gates.
No pending source-file reference is implicitly granted by this read.

`peers.exchange({id})` lazily returns that scoped exchange body plus canonical
metadata. Ownership is validated through the original request. Foreign bot/request
cursors, unavailable exchanges and excessive legacy bodies fail recoverably.

`peer` events keep legacy `request` and optionally canonical body-free `exchange`;
lifecycle-only events have `invalidateRequestId`. Root changes emit one global owner-relay `peer-root` event with
versioned root metadata. Match known root IDs in the current owner/bot view; it has
no botId and creates no participant intake or broadcast cascade. Event seq orders invalidation; immutable arrivalSequence
orders rows. Do not use delivery state or a late reply as native activity authority.

## Coordinated rollout and rollback

Capabilities are `peerRootControls:1` and `peerBodyPaging:1`. Cody owns timeline,
receipt-backed dedup, lazy bodies, bounded status, owner controls and durable browser
control recovery. Deploy the reviewed compatible UI/read consumers together before
activating this backend; old shapes/IDs remain readable, but old clients cannot
navigate arbitrarily long pages or manage recoverable pauses. Tool documentation
and DIRECT_INSTRUCTIONS are updated in the same source; home/team effective policy
changes only after actual activation proof. Current live policy remains unchanged
until Dwight's release and strict-idle handoff.

Do not downgrade to a producer enforcing twelve on roots continued beyond twelve.
Keep new root fields/receipts/local bytes and reconcile held/uncertain/committed work.
A temporary production hold can keep controls off and preserve records; never erase
policy state, reset count/IDs or automatically replay intakes as a rollback.
