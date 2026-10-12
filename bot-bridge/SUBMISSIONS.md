# Queued bot messages and submission source

`bots_message` is an authenticated hub tool. `send` accepts only recipientBotId,
text, operationId and optional replyToSubmissionId. `source` reads one exact
submission received by the calling bot. Owner reads use `submissions.source`.
There are no rooms, discussions, extra native threads or automatic replies.

## Identity and delivery

The gateway captures node, bot and placement epoch from the authenticated
connection; tool arguments cannot select sender or owner identity. Both bots
belong to the same owner. Source, ordinary default queue and local receipt commit
atomically before ACK. Recipient activity, Stop, Goals and original uncertainty
use the existing queue admission. The sender does not steer or resume anything.

New sources are user, bot, system or unknown; external agent is reserved. Human
queue/burst/schedule deliveries retain their captured author. Source records
point to original durable input records; human/private form bodies are not
copied into source envelopes. Bot text is retained for exact display without its
application-generated preface. Existing input/history is not backfilled.

The app's original submissionId is Codex's clientUserMessageId/clientId. A
submissionDelivery alias retains the distinct original mailbox/queue operation
ID. No old operations are renamed. Existing uncertain mailboxes are reconciled
with their original payload bytes, without adding attribution. New exact-ID
history joins enrich the existing native item rather than adding another bubble.

Replies validate that the sender actually received the parent bot submission
in its current conversation and addresses its original sender. The optional
replyToSubmissionId is immutable fingerprinted data, returned by source reads
and receipts. No transcript is forwarded; no thread view or ancestry inference
is created. Source provenance never grants human permission.

## Recovery and rollout

Repeat the same operationId with identical parameters after a missing tool ACK.
Authentication/revocation is checked before returning a prior receipt. Changed
payloads conflict. Local queued acceptance is distinct from native acceptance;
unknown native effects do not retry. Native IDs are exposed only after actual
positive native item/turn evidence. Offline status does not invent delivery.

Agent/hub advertise submissionSources only with the implemented owner-scoped
route. New source-bearing commands wait for that assigned-node capability.
UI metadata is optional; older services/caches keep existing appearance. New
bot bubbles show a readable registered-colour tint and name/avatar or initials.
Human scrollbar ticks exclude bot/system/unknown submissions.

Roll back presentation by hiding the capability and source UI. Retain all
submissionSource, submissionDelivery, queue, original operation and native
receipts. A backend downgrade must hold source-bearing pending commands rather
than dispatch them through an older client-ID path. Never restore old SQLite
state over newer input. Production activation uses the existing bounded idle,
private-backup, Seal/Claim, exclusive one-restart and actual health proof.
