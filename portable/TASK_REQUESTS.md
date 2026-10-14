# Assigned-node Task Requests

The application SQLite remains the authority for protected drafts, published
grants, contributor submissions, registered uploads and delivery status. The
assigned agent retains native question receipts and volatile private input.
It receives no shared storage-service credential.

The signed node connection permits only draft, assigned pending/delivery reads,
original delivery status, exact private authorization/receipt and canonical
intake/readback. It cannot publish or revoke a request, select another owner,
read another placement, or turn a guest submission into owner approval. Owner
publication and guest HTTP actions retain the existing application handlers.

## Delivery

The original TaskRequestBridge still validates contributor data, published
scope, original question hashes, registered files and private lifetime. Normal
submissions create their original `task-request-delivery` intake at the hub.
The agent persists `hub-pending` before that request. A lost ACK uses only
`intake-status`; an absent receipt is retained as uncertainty. Positive hub
readback is mirrored locally with the same original text, ID, fingerprint and
creation time. The application receives `awaiting-bot` only after this local
receipt. That confirmation is required before hub dispatch.

The hub rechecks the current published scope and immutable submission before
dispatch and immediately before the assigned agent's native admission. The
agent additionally rechecks its RAM-only private handle. Original native client
IDs, node journal attempts, Goal/queue/Stop/admission and lost-ACK recovery are
unchanged. Original non-secret native questions use the existing answer adapter
and receipt; no new question or authority role is manufactured.

No independent agent queue/schedule tick is installed. The existing bounded
agent recovery pass runs the TaskRequestBridge's bounded pending review. The
hub alone selects ordinary primary inbox admission.

## Private guest transport

A dedicated single-use `task-request` ticket can open `/connect` without an
owner session. Its signed original bot, thread and grant binding are checked
against application SQLite. It permits only create/key/chunk/status/delete for
that form. It cannot receive snapshots, history or ordinary events, send owner
RPC, or open a desktop. Placement and connection identity are checked again
after awaited routing. The original encrypted channel reauthorizes expiry and
revocation before and after crypto work. Private content remains on the agent;
only original handle/expiry/opt-in receipt metadata reaches SQLite.

Task Request envelopes are size/type checked with the common bounded protocol
but retain original JSON member ordering on the wire. This preserves existing
JSON-derived delivery fingerprints and private binding comparisons; there is
no new fingerprint or replay identity for an old submission.

## Existing grants and activation

`TASK_REQUEST_SECRET` is the private form-signing/crypto-owner key. For migrated
configuration it must retain the previous `BOTS_TICKET_SECRET` exactly. The new
gateway ticket key remains separate. The portable site and hub use the same
form key. No existing link/PIN/grant is regenerated or revoked by this adapter.

The shipping hello still advertises `centralTaskRequests: false`. Full UI
capability requires reviewed hub authority and live assigned Linux agents with
the paired capability. Mac Task Requests/secure transfer remain disabled.
Source/fixture checks do not establish installation or genuine guest/device
acceptance. Operator routing and complete staging remain separate unfinished
migration work.

Rollback must retain original form/application rows, `hub-pending` uncertainty,
private tombstones, canonical inbox IDs and any accepted native receipts. Hide
the capability before removing a consumer; do not replay an unknown delivery.
