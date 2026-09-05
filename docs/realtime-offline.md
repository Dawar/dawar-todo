# Realtime and offline architecture

The browser renders a local task store. Task persistence and network work have independent lifetimes from the Tasks, Chat and Settings screens.

- `task-store.ts` provides stable UUID keys and per-row subscriptions. Inline drafts notify only their row; title commits and search filtering leave the typing path. Server ID promotion preserves the same row and editor timers.
- `offline-store.ts` owns IndexedDB transactions. Version 9 adds individual task records, permanent local-to-server identity mappings and an attachment outbox. Task edits and their pending mutation commit together. Action acknowledgements are conditional, and an undo requested during a network call remains queued. Deleted local creates retain a tombstone until the server deletion is queued.
- `task-sync.ts` owns task reads, ordered writes, retry scheduling, connection health and an independent file lane. It can run without a mounted task screen. Web Locks prevent competing task writers, file writers and revision streams across tabs. BroadcastChannel shares committed local changes. Where Web Locks is unavailable, server operation IDs and conditional local acknowledgements remain the retry safeguards.
- `app-shell.tsx` retains visited screens with React Activity. Leaving a screen pauses its effects while preserving component state. Navigation preserves scroll position and uses browser history without a document reload. Task sync stays active while navigating. Foreground and online events resume sync after browser suspension.
- `worker/sync-events.ts` runs after the existing access checks. It streams revision hints, checks the indexed D1 revision every two seconds, emits heartbeats and closes each stream after 55 seconds. The client catches up through `/api/sync`, checks for silent stream stalls and falls back to adaptive HTTP polling. This hosting setup does not expose a Durable Object binding, so server notifications still use revision checks, not a fully event-driven database subscription.
- Tasks are created before files are transferred. Files keep their blobs and stable upload IDs until acknowledgement. A lost upload response can reuse the same attachment; already completed files are not uploaded again. Transfers resume per file, not from an arbitrary byte offset inside a large file. Expired draft attachments can be uploaded again from their saved blobs.
- Chat retry lanes share the scheduler and use stable file upload IDs. Talk sending still requires the selected conversation and an active session; leaving that screen cancels its lane while preserving queued messages and drafts. This does not promise background voice sessions or execution after the browser process closes.

## Validation

The Node suite exercises atomic saves and reopen recovery, concurrent edits, creation promotion, deletion during creation, in-flight undo, selective row subscriptions, writes during a blocked file upload, visibility and offline gating, stream cancellation and two-tab coordination. Existing API, attachment, ordering, snooze and service-worker contracts are also checked against the built output.

The typing regression runs 50 edits and observes no task-list notifications or unrelated-row notifications. This is a subscription check, not an iPhone latency benchmark. The intended device target remains immediate typing and under 100 ms for common local actions; it needs an actual device measurement after rollout.

The Site build is independent from the pre-existing type errors in `voice-relay/src/index.ts`. That separate relay was not changed or deployed in this update.
