# Owner announcements

An explicit Announcement Send captures ordinary text and up to 512 existing
non-archived/non-deleted owner bot identities. The independent draft is bounded
to the existing 200,000 character message limit. A fresh authenticated snapshot
must be ready before admission. Each registered bot and captured thread is
checked again before its request; paused/offline recipient status is not a
reason to steer or resume it. The existing queue admission decides eligibility.

`dawar-announcements-v1` IndexedDB contains an owner draft and immutable intents.
The admission transaction stores the exact common parameter text, recipient
snapshot and `announcement:<intent UUID>:<recipient index>` IDs before requests.
Each request uses authenticated `queue.add`, `{text, attachments:[],listId:null}`
and its saved original ID. The existing queue contract trims outer whitespace;
the receipt validator compares that normalized input. No configuration, reply,
file, bot-source author, native start, or other composer data is synthesized.

Recipient status is persisted as unconfirmed before transport, then settled
only by a matching queue receipt, request-bound consumed-turn receipt, or an
explicit transport rejection. Unknown responses retain the ID. Reopening,
focus and storage notifications only read. Continue/check is deliberate and
uses the same IDs; it skips confirmed and rejected recipients. A stopped queue
stays stopped. Native acceptance does not mean the bot finished the task.

Closing or owner replacement stops further fan-out. In-flight receipts still
settle in their original owner's journal. No request is redirected to a changed
thread. A deleted/archived/replaced recipient with an unknown receipt remains
blocked for original-ID review, not silently retried. The journal is local to
this browser; cross-device receipt discovery is not claimed. Cross-tab strict
transactions adopt the original pending intent and reject stale draft writes.
Failed local edits remain visible until explicit saved-draft reload. Completed
intents remain retained; New announcement is deliberate and is available only
when every recipient has a terminal delivery outcome.

The modal sits outside selected-conversation remounts. It does not select bots,
change current drafts/files/replies or move conversation anchors. Sidebar
dropdown state is removed rather than hidden. The default list retains current
Recent order and all teams; name/team search also discovers archived records.
Cmd+K and list arrow focus still use the original search/list routes.

This is frontend source using existing owner APIs. Compatible queue services
and genuine owner/device adoption require release verification. For rollback,
retain `dawar-announcements-v1` and all original queue receipts; never clear or
recreate unknown announcements or replay them as new human input.
