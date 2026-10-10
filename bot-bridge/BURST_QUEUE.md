# Owner burst-to-queue transfer

`burstQueue: 1` advertises the paired owner UI/bridge contract. Older services
omit it; ordinary Send/Pause and main composer queueing retain their contracts.

The UI awaits a positively acknowledged `bursts.stop`, then reads fresh
`bursts.read` and default `queue.list`. The burst snapshot adds optional
`threadId`, `controlRevision`, and each batch's `revision`. Cached previews are
never transfer authority. Nonempty default queues receive the selection directly;
empty default queues offer existing named lists. Cancel leaves the durable hold.

`bursts.queue` accepts only an authenticated owner-browser request:

```ts
{threadId, controlRevision, messages: [{id, batchId, revision}], listId: string | null}
```

One to 200 distinct unsent sources must belong to the current bot/thread, an
exact paused control and exact paused batch revisions, without a native
reservation/dispatch fence. Named lists and registered ready files are scoped to
that bot. Source text, native input, files, reply and original order are resolved
from accepted server records; no browser-supplied replacement content is accepted.

The synchronous local acceptance transaction appends one ordinary queue item per
source, retains each original source with terminal `queued` state/queue identity,
consumes only selected batch membership, and saves the parent operation receipt.
Queue IDs derive from the immutable original operation/message IDs. One aggregate
position read allocates contiguous ordering; one queue plus one burst event is
published after commit. No native calls, long execution lock, flush, timer setting
change, model/Goal/Stop change or new file grant occurs in this transfer.

The result carries `transfer: {operationId, botId, threadId, controlRevision,
listId, items: [{messageId, queueId}]}`. The durable browser action journal verifies
that exact binding. Uncertainty/reload reconciles the original operation ID and
parameters. A committed receipt is replayed before current source validation;
source edits/deletion/thread replacement never authorize another queue item.
Owner provenance is checked before receipt replay. An actual dispatch that wins
first remains in-flight; Queue cannot retract or duplicate it.

The main composer reuses ordinary `queue.add(listId)` and `turn.send` receipts.
Its empty-queue chooser captures draft/file/reply identity before reads. Submit now
bypasses the burst quiet window. Queue edits retain their existing checkout/update
and recovery path; no chooser promotes an uncertain operation to a new action.

Generic record storage needs no migration. For rollback after transfers, retain
the terminal `queued` reader exclusions and original transfer/queue receipts;
disable `burstQueue`/the new UI instead of reverting those compatibility fields.
An older bridge cannot interpret this terminal source state correctly (it can
show false pending counts); it must never recreate/discard transferred work to
make those counts disappear. Dwight owns paired integration and strict-idle
activation. Source/fixture proof is separate from installed owner/device delivery.
