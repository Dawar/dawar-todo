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

Copy and staging do not activate execution. Authentication, ownership, registered
files and uncertain external-effect identities remain protected. Handover still
uses the approved linked continuation, one private backup/restart and current
native/tool/Goal admission constraints. No pending action is automatically retried.
