# Named-bot voice Operator

Operator uses the existing authenticated Talk/phone session and Realtime voice.
Browser WebRTC, SIP sideband and MediaStreams share the same selected-segment
observer. The model/voice configuration remains in `talk-runtime.ts`.

## Authority and routing

The Sites server signs a short-lived existing owner relay ticket privately. Only
selected Operator methods are exposed as Realtime tools. The local bridge routes
work into the named bot's persistent thread via existing `queue.add`, `turn.send`,
`requests.respond` and explicit `turn.interrupt` contracts. The request's native
operation ID is derived once from the original session/tool-call ID and retained
before dispatch. Unknown delivery is reconciled under that identity, never replayed
under a fresh ID. Voice acknowledgement is not native execution or completion.

Directory matching uses name, bounded purpose/role and bot extension. Optional
`BOTS_OPERATOR_ALIASES` is a JSON object mapping a spoken alias to an existing bot
ID; no aliases are installed by this release. Multiple matches require human
clarification. Archived, deleted and legacy bots cannot receive Operator intake.

Selected context contains bounded fresh identity/decisions/recent native messages
and native activity/goal reference. It grants no permission and replaces the
previous bot's active instruction/tool scope after server confirmation. The voice
conversation is not forwarded as a native prompt; only the human's selected words
are submitted. Bot model, reasoning, Fast and mode choices are retained.

## Records and readback

Local `operatorCall`, `operatorSegment`, `operatorTranscript` and `operatorRequest`
rows contain routing, transcript and exact intake receipts only. They never own
activity or objectives. Cloud `todo_operator_sessions` binds the authenticated
call to its confirmed routing context. Existing Talk phone/session/transcript/tool
receipts remain unchanged and readable.

Native turn/client IDs and pending question IDs determine progress/input/results.
A terminal native observation can be retained as historical evidence, never as
cached active work. A completed turn without a final answer is reported as a turn
ending, not an objective completion. Call history is paged, and each bot card shows
only its own segment. Full native replies/questions/attachments remain in the bot
conversation, linked from the card. Optional exact-call origin metadata enriches
conversation-v6 entries/events without changing their projection authority.

Ten-second readback heartbeats offer useful new native progress/results/questions
when voice is not speaking. Late evidence is attributed to its original bot and
segment through response metadata. This is observation, not automatic submission.
SIP reconnect retains routing, item attribution and seen-result fingerprints.

## Stop and retention

Barge-in, Stop speaking, switching and hangup affect audio only. Explicit Stop bot
uses normal main Stop and pauses automatic intake. Exact cancellation removes only
positively unstarted local queue input using its saved revision; native-queued,
running or uncertain delivery is retained. Approval requests stay in normal UI.

Legacy Chat navigation and obsolete threads are not retired by this commit.
Calling still uses its Talk session/thread/transcript/tool retention dependencies.
Retirement requires real replacement-call acceptance and a separately reviewed
scoped migration, retaining all necessary call records, profiles, PIN/auth, urgent
phone/SMS flows and native bot/Todo data. No tables/files are deleted here.

## Release and acceptance

Publish the compatible voice Worker and Sites frontend/API, then activate the
reviewed combined backend only through one strict-idle restart receipt. Call icons
are capability gated (`operatorCalls:1`). Real microphone, phone transport,
routing/switching, barge-in, reconnect and result readback require human acceptance;
source/build/manual synthetic component review does not prove those scenarios.
