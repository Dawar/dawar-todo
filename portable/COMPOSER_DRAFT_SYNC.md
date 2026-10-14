# Composer draft sync

The portable site synchronizes each signed-in owner's normal per-bot composer.
Drafts live in the existing application SQLite `app_settings` namespace. All
writes use the existing authenticated application binding and exclusive hub
writer fence; this feature opens no additional database or native writer.

Local IndexedDB remains durable while offline. Saves debounce 250 ms and use a
revision CAS plus an ID committed locally before the request. A bounded tail of
32 mutation fingerprints recovers original acknowledgements. Older revisions
cannot reapply after the tail expires. Requests carry no device clock authority.
There are at most 1024 draft records and 1 MB per mutation; draft text is limited
to 200,000 characters. Bodies and draft content are never logged.

One owner/bot-scoped SSE connection follows the open composer in the single
portable Node site process. It receives invalidations after persistence. It
reads once on connection/reconnection; there is no recurring draft polling.
Heartbeats keep the transport alive. Streams close after 55 seconds to reacquire
session authentication. Focus, re-open and reconnect reconcile durable SQLite
state, including changes missed during a site restart.

The initial central draft takes precedence over an unchanged older local draft;
the displaced local draft remains in Saved drafts. Concurrent/offline divergent
typing keeps the local branch active, retains the other branch as a saved
version and blocks its automatic overwrite of newer central state. An explicit
new edit can save against the now-confirmed revision. Late reads cannot replace
typing that began while the read was running.

Text, same-bot reply references and ready uploaded-file references synchronize.
File bytes and unfinished local uploads remain on their originating device
until the existing upload completes. Only registered same-bot IDs transfer;
no filesystem paths or private-form bodies enter drafts. Existing download and
send authorization revalidates those references.

Queue edits, PDF reviews, run drafts, clipboard snapshots and pending/uncertain
native send journals remain separate and local. Sync never sends a message,
starts a model turn or promotes an unsubmitted draft on reconnect. A confirmed
send clears the exact captured local version; late draft ACKs cannot resurrect
it or clear later typing. Existing user Stop and queues are untouched.

Deploy through the portable site's normal reviewed web release. No execution
agent or Codex restart is needed. Rollback the site release only and retain all
draft rows, local journals and IDB bytes. Physical phone/PWA adoption is distinct
from isolated HTTP, SQLite and independent-device-store verification.
