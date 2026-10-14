# Account usage history

`AccountUsageCollector` is observational, account-wide and independent of bots,
threads, schedules, goals and execution locks. It starts after runtime readiness,
coalesces startup/manual/relay reads, reads hourly and backs off after failures.
Each pass makes four metadata RPCs: `account/read` before and after, plus
`account/rateLimits/read` and optional `account/usage/read`. Reads have 15-second
timeouts. Before each stage and after its responses it checks runtime readiness,
collector generation and the maintenance hold. Shutdown invalidates late results;
it does not pretend to cancel an already written RPC or remove its pending entry.

Global `account/updated` invalidates the binding before thread routing. Sparse
`account/rateLimits/updated` merges only non-null validated fields into the verified
connection. Field observation times and sequence fences preserve newer updates
against an older in-flight snapshot. There is no token-usage notification contract.

## Scope and persistence

Quota `accountId` and workspace `chatgptAccountId` have distinct namespaces. The
history key hashes the source-labelled IDs, routing origin and an ephemeral auth
fingerprint; it stores no raw account IDs, email, credentials or conversation text.
The collector does not connect to the routing origin. Before/after auth mismatches
discard the entire read. A successful read losing/changing identity creates a
separate scope; a failed quota read can retain the previous verified scope only
after unchanged fresh account verification. If no native ID establishes continuity,
the connection gets an opaque segment that is not joined across service restarts.
Revisiting another stored scope starts a new quota segment. Cursor generations
contain no private identity and cannot select another account's history.

Additive SQLite tables `usage_windows`, `usage_samples`, `usage_tokens` and
`usage_activity` hold only scoped numeric observations and native quota labels.
Retention is 90 days, pruned at most hourly. Samples retain at most one per minute
per bucket/window, including reset transitions. Token dates are service labels;
same-date responses replace the bucket, never add it again or infer missing zeroes.
Unsafe native integer literals are projected to exact decimal strings only in a
matched successful `account/usage/read` response. Invalid precision is unavailable,
never a string made from a rounded Number. Ordinary RPCs and native settlement
remain unchanged.

## Owner interfaces

Actual runtime snapshot capability `accountUsageHistory: 1` enables the UI.
`usage.history({range: "24h" | "7d" | "30d", cursor?: string | null})` requires
the authenticated owner relay context, rejects bot provenance, and performs no
native reads. It returns version 1, an opaque account generation, freshness,
coverage, up to six separate quota windows and `nextCursor`. Each window has at
most 722 hourly chart points; recent forecasts query at most 1,442 minute points.
Token charts contain at most 92 service date buckets for the selected interval.
Whole daily buckets overlapping an interval are labelled accordingly. Existing
large-response chunking handles a worst-case multi-window 30-day page.

Existing `usage.account({})` still refreshes and returns its original quota shape;
additive per-field metadata observation times accompany retained fields.
`usage.account({refresh:false})` returns saved values without polling native Codex.
`usage.bot` is unchanged. Body-free global `usage` invalidations notify open panels.
An open panel also rechecks saved history each minute and ages estimates locally
if reads fail, accounting for clock differences using elapsed time since receipt.
These checks create no bot schedule, native thread read or inference.

## Forecast semantics

Six-hour and 24-hour forecasts are independent. At least three observations must
span 80% of the horizon, with no gap over two hours and latest data under 90 minutes
old. Changed account/window/model/reset or unexplained percentage decreases split
the segment. Missing or stale window definitions suppress estimates and budgets.
Definition changes without a new percentage cannot reuse an old segment's budget.
Consumption is percentage-point growth divided by measured elapsed hours.
Depletion is remaining percentage divided by that rate; reset outlook compares
the duration to native reset time. Sustainable daily pace is remaining percentage
divided by days to reset. Rounded unchanged percentages mean no measurable
consumption, never unlimited quota. Tokens are never converted into quota.

This release does not redeem credits, send alerts, pause execution, create queues,
change models or resume goals. Source, published frontend and installed collector
are separate release states. Dwight owns paired review/publication and compatible
strict-idle backend activation. Real account encoding, physical Safari and live
90-day collection remain separate from disposable source/component evidence.
