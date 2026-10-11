# Owner-approved practical database copy

Dawar's October 10 amendment accepts a small loss of recent conversation/work
activity. A separately configured `dawar-original-database-reader` may therefore
copy the original application while its actual D1 write fence is held. This is
a database-consistent copy; it does not assert that external providers, old RAM,
native conversations or issued upload policies are perfectly synchronized.

The default reader still requires every external writer authority. The practical
reader requires private deployment configuration with `recentTailLossAccepted:
true`, the existing authenticated owner, exact source installation lineage,
original freeze operation/generation/deadline and original schema/guard hashes.
The encrypted request binding explicitly carries `scope: d1-database-writes`.
Neither a browser request nor a database-only proof can satisfy the strict path.

The deployment-owned database reader also enables its exact original database
freeze without requiring the request journal to become idle. Unfinished journal
records remain unchanged in the snapshot. The original journal drain/release is
not repeated. This does not qualify a native restart or public writer handover.

Copy and staging do not activate execution. Authentication, ownership, registered
files and uncertain external-effect identities remain protected. Handover still
uses the approved linked continuation, one private backup/restart and current
native/tool/Goal admission constraints. No pending action is automatically retried.
# Bounded batched application copy

The first database-only copy expired after 15 minutes and released its exact
original fence. It produced no completed snapshot. That original freeze and
release receipt remain intact.

The reviewed reader adds fixed `inventory` and `page` commands. Inventory derives
schema, columns, ordering, counts and sequences from the actual database, using
bounded batches of at most 32 tables. Pages combine length discovery and row
reading within one owner-authenticated encrypted HTTP exchange. A page has at
most 1024 rows and a conservative 1 MiB byte budget, except one bounded row up to
the existing 4 MiB line ceiling. SQL and projections remain server-derived.

The private capture binds the positively released prior database generation and
one new, explicitly recorded copy operation. It never reuses the first operation
with changed arguments or deadline. All existing owner, source, schema, expiry,
encryption, receipt and final revalidation checks remain. Metadata is checked
again before download; inactive import verifies every table and complete hash.

This is application-data staging. It does not restart native execution, renew a
failed runtime attempt, establish external-effect completion or authorize replay.
