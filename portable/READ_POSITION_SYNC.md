# Conversation read state

Read position is owner + bot + foreground thread + observed `updatedAt`.
Reading the loaded latest conversation for 800 ms while visible and at its
bottom records that watermark locally. It never marks a newly selected but
unloaded conversation, an older page, or unseen later output as read.

Portable browsers persist watermarks in the existing fenced application
SQLite `app_settings` namespace. Authenticated `/api/bots/read` supports a
bounded owner-wide read and a 1 KiB, exact-shape PATCH. The SQL update takes
the maximum timestamp atomically. Duplicate requests, old tabs, a lost ACK,
or an older server snapshot cannot move a watermark backwards. No model,
queue, native input, receipt, Goal or bot control row changes.

The captured owner is a fence, not authentication. Gateway session validation,
identity-header stripping and CSRF checks precede the application route.
Other owners and foreground threads have separate keys. At most 1024
watermarks are retained per owner; capacity refusal leaves local state intact.

One owner-wide SSE stream invalidates after persistence. Opening, focus,
reconnect and committed events read durable state; there is no recurring read
interval. Streams share the same bounded event helper as composer drafts.
Failures use three backoff attempts, then wait for a later focus/online/read
event. Browser state stays usable if storage or the connection is unavailable.

Full snapshots and live bot events preserve the newest server watermark for
the same bot/thread. The browser overlays its actual observed and centrally
confirmed watermarks. New output after the watermark remains unread. Legacy
services retain their existing `bots.read` path. Portable browsers use the
application API, including installations predating native `bots.read` support.

Rollback the site source only; preserve these rows and local markers. A later
compatible native backend can coexist: UI comparison always takes the newest
scoped watermark. Site publication is not a bot-backend restart or a claim of
physical-device acceptance.
