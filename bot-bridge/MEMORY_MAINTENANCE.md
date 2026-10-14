# Bot file memory maintenance v1

Scope: each named bot's own MEMORY.md. Native history, Goals, team catalog,
queues, settings, model choices, attachments and secure RAM transport are separate.
This is not a process isolation boundary for the shared trusted Unix account.

## Admission and cadence

`botMemoryMaintenance:1` advertises the installed contract. A rotating background
scanner examines one otherwise-idle bot per dispatcher pass, with five-minute
per-bot metadata backoff. At 32768 UTF-8 bytes it obtains bounded current
thread/goal metadata (two parallel calls, each 3 seconds), then prepares a private
backup. It does not read native history, execute inference, or acquire a bot's
admission lock. Metadata/backup preparation is canceled by human intake/activity.

The only nightly cadence is existing schedule
`tool:exec-fe42a6bd-08e8-4717-8836-194c9d51e5a1`, 03:30 America/Toronto.
It remains disabled during source preparation. After verified installation,
Dwight reconciles that exact schedule and its prompt to call
`bots_memory_maintenance({operation:"nightlyCheck"})` in the original observed
scheduled occurrence. This records due checks, not completed inspections or
execution. The same occurrence is idempotent. Busy bots defer until idle; healthy
small files produce no intake. Do not add another cron or every-bot schedules.

One `memory-v1-<sha256>` operation is bound to bot/thread/canonical workspace
identity, exact UTF-8 source hash and file version (inode, owner, permissions,
size, nanosecond modification/change times). Size/nightly triggers coalesce.
One ordinary `maintenance:<operationId>` primary intake uses the bot's existing
model/settings/thread. It ranks behind human prompts, schedules, peer intake and
secure receipts; active work, questions, Stop, unresolved receipts, bursts and
active Goals hold it. A terminal attempt without a commit is retained for review,
not replayed. A changed source before native submission retires only that
positively unsent maintenance record. A new exact file version needs new review.
No native start/steer/Goal resume or history compaction is introduced.

## Tool and file transaction

Dynamic new-thread and existing authenticated bot MCP plumbing expose
`bots_memory_maintenance`. Retained worker/run origins and foreign fields/scopes
are rejected. Mutations require the current observed primary native turn; tools
return bounded metadata only. Types are in `lib/bot-memory-types.ts`.

1. `inspect` returns bytes/hash/threshold/status, or the original receipt with
   `operationId`. `prepare` returns the deterministic operation plus fixed private
   archive/candidate paths. Supplying its original ID reads the retained receipt.
2. Read the full archived source, then write `candidate.md` (0600), at most 24576
   UTF-8 bytes. Keep current constraints, approvals, unfinished scopes, uncertainty
   identities and evidence pointers. Include its exact private source.md reference.
   Do not directly overwrite active MEMORY.md or publish these archives.
3. `verify` takes original operation ID, exact candidate SHA-256 and five bounded
   review statements: constraints, approvals, unfinishedWork, uncertainOperations,
   references. Current source version and full backup must still match. The
   server binds own-bot/model-turn provenance. This proves byte identity, scope,
   freshness and recorded semantic review; it cannot mathematically prove that
   the model understood or preserved every fact. Real semantic acceptance remains
   necessary, including preservation of original authority and unfinished work.
4. `commit` takes the SAME ID/hash. It checks source/candidate/version/activity
   again, writes/fsyncs a private temporary candidate, persists `committing`, then
   uses a fixed-file Linux `renameat2(RENAME_EXCHANGE)` helper. The displaced file
   is retained alongside the pre-compaction archive. A source edit in the final
   hash/rename gap is detected and restored when safe. If both locations changed,
   retain both and block ordinary delivery rather than overwrite either.
5. A lost ACK/service reopen compares original archive, installed candidate and
   displaced source hashes. Positive exchange evidence finalizes the SAME receipt
   without another exchange. An unchanged original is not evidence of completion.
   Changed sources/candidates never authorize blind replay. A positively restored
   original inode with the candidate still private becomes `stale` and requires a
   fresh review. Files and receipts are never automatically deleted.

Private directories are 0700; backups/candidate/temp/receipts are 0600. Reads
use owned canonical directories, anchored descriptors, O_NOFOLLOW/O_NONBLOCK,
singly linked regular files, bounded streaming reads and before/after identity
checks. Sources are capped at 8 MiB for exceptional recovery; ordinary profile
delivery still caps each mandatory profile at 128 KiB. MEMORY alone has a narrow
verified fallback. This does not relax any other profile/team limits. The helper
requires existing Linux/Python3/renameat2 support and is limited to fixed names;
there is no arbitrary path/script/admin tool. Missing support fails recoverably.
Hostile same-account writers remain outside isolation guarantees. Archives retain
displaced writes; highly concurrent manual edits may require inspection/repair.

## Profile delivery and visible state

`Bot.profilePreparation` is optional owner/bot/thread-scoped metadata with
warning/fallback/blocked, bounded diagnosis and optional source/operation identity.
It is separate from native connectivity/current activity. The existing composer
shows it without mutating its draft/files or adding conversation copies. Old
clients ignore the field; absent field remains compatible.

At 32 KiB ordinary delivery still includes the full safe current memory and warns.
Preparation/verification locks do not reject that ordinary read. Current-receipt
metadata and verified fallback bytes are inspected without acquiring, creating,
clearing or waiting on a mutation lock. Private ownership, anchored paths, byte
limits, source identity and receipt/candidate stability are still checked.
A committing receipt retains the exclusive original-ID reconciliation gate;
unknown exchanges never become safe reads merely because human intake canceled
background preparation. Cancellation can leave file I/O settling with its lock
still held, while safe noncommitting profile preparation proceeds independently.
Above 128 KiB, only a private verified candidate bound to that EXACT current
source/version and valid own-turn review may substitute, with an archive/hash
reference. A stale, missing, corrupt, unsafe or unresolved fallback blocks before
native submission and retains the original input/files. Actual missing profile
files retain the existing explicit missing-facts instruction; missing internal
receipts must never masquerade as missing personal memory.

Direct Send and bursts receive ordinary native additionalContext. The pinned
queue/add protocol has no additionalContext: queued/automatic inputs are gated
and, only for a verified fallback, gain a small ordinary text reference to its
fixed local candidate/archive (original text/files remain intact). Maintenance
alone receives a small validated current-file reference plus an explicit full
source-archive task under the permanent mandatory-read policy. The model must
read the current profiles/team/source through normal tools; bodies are not copied
into another user bubble. This is not an empty invented ordinary fallback or
additional permissions. Retained runs keep their original frozen scope while receiving a
fresh separate file-memory reference; current unsafe/stale memory blocks before
native submission there too. No model context is supplied by UI styling alone.

## Release, rollback and acceptance

No schema migration or provider/access change. Metadata uses existing local record
kinds; archives remain in the bot workspace and never use S3. Stop/IDs/history/
original files stay intact. Dwight integrates with accepted descendants and Cody's
admission/display work, publishes the small UI delta, then owns one compatible
strict-idle backend activation. Confirm actual capability, tool list, helper,
process version/readiness/relay, assets/PWA adoption and staged schedule readback
before enabling that one cadence. Do not restart active work or use a pinned old
source helper. Source/manual evidence does not establish live delivery.

Rollback disables the original nightly schedule first and reverts these source
hooks through Dwight. Retain all private receipts/archives/active memory; do not
restore an old oversized source over newer facts. Old code still has its original
128 KiB guard. Unconfirmed exchanges require same-ID hash inspection before
rollback/repair. No recurring implementation, queue flush or rejected-input replay.

Finite disposable actual-file/Store/BotRuntime and React/native-IDB/Chromium
inspection covers byte thresholds, current/stale/corrupt fallback, source/candidate
CAS, permissions, Unicode, interrupted replacement/receipt, repeat ACK/reopen,
idle/question/Stop deferral and draft/file retention. No automated suites or real
native inference/messages/business mutations were run. Genuine model compaction,
normal human delivery, physical Safari and installed nightly cadence remain
explicit post-review acceptance gates.
