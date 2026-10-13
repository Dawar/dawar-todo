# Confirmed-turn supervision

`reconcileActiveTurns` uses `HistoryReads.metadata` only when the current bot,
thread and turn already have native active-turn evidence. A running summary
updates the watchdog observation only; it does not renew current activity,
bind an input, clear questions, complete a Plan or establish a terminal result.

Terminal turns, sparse/notLoaded metadata, and pending question, Plan or
scheduled-provenance consumers use the unchanged full `findNativeTurn` reader.
A freshly validated metadata location may start that full read; the location
is only a cursor hint, and the full response must verify the exact turn again.
Missing/error metadata falls back to the original discovery cursor and original
four pages of 25 turns. Missing/partial full evidence remains unconfirmed.
Only a response declaring `itemsView: full` reaches existing terminal and
scheduled consumers. No selected-turn item pagination or unbounded `.turn`
exhaustion was added.

Scalar, bot/thread/turn-scoped SQLite existence checks select the required
evidence view without materializing historical question/Plan/prompt bodies.
They add local query work. Terminal/provenance recovery adds summary calls;
normal running materialization is the intended saving. The existing metadata
hint/discovery limit and full-discovery limit remain finite. Native initialization
hydration, fair admission, coalescing and concurrency are unchanged.

The watchdog retains its two-bot limit, bot lock and 60-second interval. Awaited
results are fenced by captured thread/turn, activity generation, native process,
runtime epoch and current watchdog state. A replaced thread cannot reuse an old
watch cursor/deadline. Legacy watches without a thread binding start fresh.
The original turn-discovery cursor stays distinct from native item cursors.

Generic client/unknown-receipt recovery, reader defaults, queue acceptance,
native notifications, Plan lifecycle, current-activity recovery, maintenance,
collaboration, portable routing, public DTOs and UI are unchanged. No new cache,
RPC, capability, schema, dispatch, timer, replay or execution authority exists.
Installation requires the production owner's compatible safe runtime activation;
frontend publication alone cannot install this internal reader change.
