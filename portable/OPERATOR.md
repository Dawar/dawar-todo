# Canonical Operator routing

The hub retains the original Operator call, selection segment, transcript,
request and operation records. The existing OperatorCalls implementation
chooses normal Send, explicit queue, exact inline answer, Stop or cancellation.
It does not broadcast or create a second foreground thread.

Native history, workspace references, active turn evidence and input-question
validation come from the live assigned Linux agent. Bounded reads carry an
exact captured call/segment/bot/thread scope; current placement and socket are
checked after awaits. Native question rows and RAM epochs are never cached on
the hub. Private input questions remain unavailable to voice.

Normal native actions keep `${originalOperation}:native` and their unchanged
parameters. The hub mailbox persists before delivery; the node journals before
ACK. The original Operator request is mirrored on the node for event origin
and exact receipt/history attribution. Explicit queue entries stay on the hub;
their original call source follows the same canonical queued input at admission.
No original missing/unknown native receipt authorizes resubmission.

The Node application uses a fixed loopback POST instead of Cloudflare's
WebSocket response object. A short-lived HMAC binds purpose, exact body and
route. The configured original owner remains required. There is no redirect,
token exposure, browser header impersonation or ambiguous mutation retry.
Browser Operator requests retain ordinary authenticated gateway sessions.

Shipping `centralOperator` and voice remain disabled pending complete Linux
staging and installation. This source adapter is not proof of a live call,
provider routing, audio/device acceptance or an installed capability. Mac
Operator/desktop/testing remain deferred.
