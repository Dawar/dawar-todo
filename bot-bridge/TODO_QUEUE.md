# Task imports into the ordinary bot queue

This consumer pairs with `TASK_FILE_EXPORT.md`. The owner selects one existing bot
and its default (`listId: null`) or existing named list. Each selected task has
separate durable export, queue-add and task-disposition operation IDs. No composer
write, native turn start, queue flush or task completion is part of an import.

## Acceptance and recovery

`queue.add` optionally takes `taskExportId`, `taskSource: {todoId, revision,
exportOperationId}` and the original `listId`. Only the authenticated owner-browser
relay may use this producer. The private export resolver supplies the text and
registered attachment IDs; caller-supplied text/files/reply are rejected. Before
new acceptance the consumer verifies current source and actual local bot state,
materializes ordinary input, then checks source again. It commits the staged item
and original operation receipt together. Stop and existing queue ordering remain
in force. No-source queue calls preserve their former fingerprints and behavior.

The source binding accompanies the queue receipt, native dispatch fingerprint and
attachment receipt. Explicit queue edits/moves retain provenance. Merge retains
member bindings. The original acceptance destination remains immutable even when
an item moves. A lost ACK retries exactly the original ID and params, checking the
local acceptance receipt before any current-source or file lookup.

`queue.taskConfirm({queueOperationId, taskExportId})` requires that exact positive
queue receipt. It calls private `taskQueueDelegate` with its own original operation
ID. It never submits queue input. Retrying even a completed confirmation returns
the original delegation receipt with a fresh active-task observation.

## Task disposition

Additive migration 0036 preserves Jim's 0035 export table. Separate state and
immutable owner-scoped receipts retain complete source tasks. Source/file triggers
increment a generation, including same-timestamp edits and delete/restore. A
current source check plus atomic generation CAS commits receipt and marker. Old
receipt recovery never re-hides a newer edit. Marker changes participate in the
existing task sync feed. The UI hides valid markers from active, snoozed, pinned
views/counts and the app badge; All, search and direct detail retain the originals.
Local drafts/offline changes make the source active conservatively.

The browser journal is owner-scoped and persists IDs/destination before requests.
It stores compact revision/binding metadata, not full task bodies. Web Locks reserve
new intents across tabs; unavailable locks or storage leave tasks unsubmitted.
Partial bulk transfers reconcile each original independently. Definitely rejected
new submissions stay active; unknown acceptance never creates a replacement ID.
Existing prepared/appended Forward-to-composer recovery is still explicit and is
never converted into queued work.

## Bounds and release

Export bounds remain 12 files / 100 MiB each / 190,000 title+notes characters.
The existing bridge response chunking carries large Unicode receipts; task text
is not truncated or given a separate arbitrary byte cutoff.

Cloud export and delegation schema/API must be installed before the compatible
bridge advertises `taskQueues: 1`. That capability alone is not a release receipt.
Dwight reviews the exact paired source and owns cloud publication plus one strictly
idle combined bridge activation. Genuine owner/provider/mobile/native intake
acceptance remains separate from disposable source/component checks. Rollback
removes the paired UI/bridge use while retaining additive tables and receipts;
never delete uncertain input or rewrite original tasks.
