# Named collaboration runtime v1

Source contract for the approved October 8 collaboration/configuration work.
`collaborationRooms: 1` and `executionConfiguration: 1` are advertised when this
bridge source is installed, not proof of installation or owner-device support.
The immutable approved designs and `BOT_COLLABORATION_CONFIG_CONTRACT_20261008.md`
remain the requirements. Cody owns the app consumers; Dwight owns release.

## Identity, transport and admission

The owner-authenticated bridge accepts the additive operations in
`lib/bots-operations.ts`. Room membership is independent of team assignment.
`conversations.create` gives an unordered pair a canonical identity; named
groups and membership/hold changes require the authenticated owner and revision
CAS. Membership grants no human/action authority. No old peers or inputs are
imported, replayed, converted or given a fresh discussion allowance.

`conversations.post` atomically saves the immutable post and a distinct original
delivery for every explicitly addressed task/question recipient. Info/result
posts have no recipients and never start a model. Human Send may include
`steer: {botId: capturedActiveTurnId}`; bot posts cannot steer. Partial ACKs stay
per-recipient. Repeated same-ID mutations recover only their exact authenticated
author/method/bot/input fingerprint. Native tools are bound to the registered
current context/thread/turn, before old-success recovery. A foreground MCP call
also requires its matching current native `mcpToolCall` observation; token-only,
missing, completed, ambiguous or out-of-order proof fails closed.

A collaboration context is created lazily, as the same named bot, with current
identity/profile/team references and selected objective/boundaries. It has no
history fork, copied Goal, anonymous worker or changed provider/account access.
One collaboration turn per bot runs alongside the foreground; other work stays
in the durable mailbox. Up to eight native-resident auxiliary contexts/runs are
admitted. Native idle proof, no owned work, empty native queue and no active Goal
precede unsubscribe. Unsubscribe is not resource reclamation: native loaded-list
evidence must confirm capacity. An uncertain creation/release is retained, never
replaced with another thread. The pinned thread/start has no caller idempotency
key; a lost creation ACK therefore needs independent exact identity evidence
before it can be recovered. This runtime does not guess that identity.

Conversation pages carry immutable `order`, `nextCursor`, `complete`; 1–40 rows
and 96 KiB per page. Native history uses the existing bounded reader with a
context/thread-bound outer cursor. Events use the existing durable global event
sequence plus explicit room/context/thread/turn identities. Room native events
do not update foreground preview, active turn, history revision or queue. Large
events retain the normal history-refresh descriptor. Reconnect reads pages;
partial pages are not deletion. Active question metadata is separately paged by
`conversations.requests`. Old synchronous questions remain visible but become
unavailable after a process restart; async answers have original-ID deliveries.

Room reads and result inbox reads additionally accept `view: "latest"` without
a cursor for a bounded recent tail. Items remain chronological. `olderCursor`
continues with `view: "older"`; `complete` means that backward snapshot has no
remaining older page. `newerCursor` starts `view: "newer"` catch-up. Its first
read captures a `highWater`; continuation pages keep that watermark frozen so
new arrivals cannot extend a catch-up indefinitely. On completion, the returned
`newerCursor` starts the next catch-up after that watermark. All new cursors are
opaque kind/bot/query-scope/direction positions, not authorization. Every read
still checks current membership/caller scope. Recent pages reserve envelope
space inside the existing byte ceiling; unread large records remain retained.
Without `view`, the existing numeric forward cursor behavior is unchanged.
Newer pages omit `olderCursor`: retain the existing backward reading position.
Events invalidate mutable delivery/result metadata; a partial page never
deletes retained history or replaces unrelated scope. Opening a recent room
does not scan its whole log or start a model.

Authenticated current named bots can create both pairs and groups including
themselves with 2–12 active named members. Only the owner changes membership or
hold; creation/membership supplies no new approval or external-action authority.

## Results and shared effects

The context publishes one explicit useful `collaboration.result` against its
original accepted delivery. Results retain work/request/root/native identities,
outcome and concise references. A completed delivery without the requested
explicit result reports `resultState: missing`, rather than inventing success.
The inbox and receipt indicators are passive: no courtesy ACK or foreground
wakeup. Deliberate promotion requires a current foreground dependency/milestone,
or an owner-selected related human boundary, and queues normal intake once at
idle. It never steers an active foreground. Original promotion receipt and
explicit exact-turn consumption are separate records.

Resource ownership is durable, by context and original effect ID. Desktop is
bot-scoped; shared workspace/external resources are global. No expired lease
reassigns an unknown effect. Context desktop input and artifact/download tools
require ownership; mediated effects have immutable input fingerprints and
same-ID result/uncertainty receipts. Unknown effects cannot run again or be
released. Foreground desktop/file adapters refuse another context's ownership.
Existing screenshot-before-input, human control, browser retention, private file
containment and cloud transport contracts remain in force. Artifact provenance
includes room/context; events target the room, not foreground history. Publish
room artifacts explicitly with `bots_publish_artifact`.

These guards mediate the app's desktop/file tools. They do not introduce an OS
security sandbox around existing native shell/plugin capabilities. Those retain
the bot's existing permissions and must obey the common resource/isolated
worktree policy. No arbitrary filesystem/admin/provider capability is added.
Real native concurrency and external-effect behavior still require genuine
acceptance; synthetic transport observations cannot establish them.

Global bot Stop prevents all new context starts and captures registered active,
accepted/unknown and provisioning identities. Existing supported interrupt and
automatic Goal-pause receipts remain exact and uncertain outcomes are never
repeated. Room hold only fences its mailbox. Maintenance/first-bootstrap guards,
health, browser retention and idle file-memory maintenance include contexts,
deliveries, pending questions, Goals, resources and uncertain effects. An atomic
SQLite scalar change fence catches equal-count mutations without reading room
transcripts. No feature activation is authorized by these endpoints.

## Configuration evidence

`execution.config` supplies current-context active/selected/history records and
future defaults. Admission freezes resolved model/effort/tier/mode, settings
revision, source and timestamp before native submission; the acknowledged
original turn ID binds it. Steering adds no setting snapshot and consumes no
foreground Plan intent. Current selectors never backfill active/historic turns.
Missing/conflicting records are Unknown. The pinned native Turn lacks effective
model/effort/tier fields: `effective` stays null. Explicit turn/start ACK means
accepted requested input, not independent effective execution proof. Native
queue/add inherited choices remain Requested even after exact input acceptance.

Settings saves use the existing ordered bot lock/native settings ACK, reporting
Saving, Saved for next turn or Unconfirmed. A non-settings save does not fabricate
configuration confirmation. Explicit settings revision on `queue.add/update`
is preserved with the original input, but reports `pending-unsupported` and is
not dispatched: pinned native queue/add cannot freeze per-message settings
against automatic-start/save races. Ordinary queued input without that explicit
intent keeps its existing behavior. Unsupported model effort/Fast choices use
the existing actionable validation errors. No automatic restart applies them.

## Review and rollout

No app UI is implemented here. Source, paired Cody consumers, publication,
compatible backend installation and genuine owner/PWA/Safari/native concurrency
acceptance are separate gates. Dwight alone reviews/integrates/releases through
one exclusive strict-idle compatible activation with private backup and health
proof. Existing queued work, settings, Goal/Stop and original receipts stay intact.
