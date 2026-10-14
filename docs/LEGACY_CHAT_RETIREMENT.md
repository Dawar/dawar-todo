# Legacy Chat retirement — October 3, 2026

The Chat view and thread CRUD are retired. `/talk` redirects to `/bots`; all old
thread and global Chat-history APIs return 410. New browser calls start only in
Operator, and phone/SIP/MediaStreams start and reconnect by their original call
session. Transcript/history reads use a call session, never a Chat thread.
Search can still find retained prior call transcripts.

`todo_call_messages` retains original message/session/realtime IDs, text,
metadata and chronology for browser and phone calls. Existing call sessions,
tool receipts, Operator bindings, phone/PIN/profile, recording/urgent flows and
native bot history remain. The embedded fallback stream uses the same Operator
question/context/answer/readback contracts as the external SIP and audio worker.

The one-time owner-scoped migration is `dwight-legacy-chat-retirement-20261003-v1`.
It runs from existing maintenance after the calling replacement is published.
It defers during a current call. It snapshots only the configured bot owner's
legacy Chat rows, inspects live foreign keys, encrypts the full snapshot using
AES-GCM with a random salt/IV and a domain-separated HKDF of the existing private
server ticket key, and validates decryption before any destructive statement.
An atomic D1 batch compares every row/field and count, stores the encrypted backup,
copies and verifies call transcripts, removes obsolete imported text sessions
and their receipts, nulls retired thread links on surviving calls/receipts, deletes
that owner's old Chat messages/threads, and commits one durable receipt.
A late write, ID conflict or unknown dependency rolls the entire batch back.
D1 reserved `_cf_KV` is excluded from PRAGMA inspection; every application table
is inspected. Safe failure diagnostics expose stage/category only, never SQL or
private row values.
The original operation ID is never replaced on uncertainty.

The encrypted backup chunks and metadata have no public route; they can be copied
through the authenticated database viewer to an owner-only local archive. Restore
requires the original private server key, salt, IV, operation ID as authenticated
data and the documented HKDF context. Do not rotate that key without retaining a
private recovery path. A backup is not a live Chat thread store.

Frozen legacy schema declarations retain other tenant records outside Dawar's
cleanup authorization. Runtime code cannot create/import/purge Chat threads.
Original task-assistant records/memories are unrelated task data, not disposable
Chat imports, and remain intact.

Production acceptance must record the actual migration receipt, deleted and
retained counts and exact identities, encrypted-backup integrity, site version,
retired-route responses, process/Codex readiness and relay health. Manual local
migration/UI review is not evidence of a real phone call. Human phone/browser
acceptance remains explicit; no incidental calls or business answers are sent.
