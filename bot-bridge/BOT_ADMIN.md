# Named bot and team provisioning

`bots_admin` supports exact owner-approved creation by any active named bot.
Team catalog/metadata/membership actions require a separately configured lead.
It is not the legacy worker tool and cannot execute arbitrary owner RPCs.
All bot identities are derived from the authenticated calling bot. Retained
workers/history remain available and are not deleted by this feature.

## Activation

Creation is available to active single-thread bots, but has no effect without an
explicit owner approval of that particular caller/request/spec/count/execution ID.
`BOTS_ADMIN_LEAD_IDS` defaults to an empty owner-managed JSON array of existing
named-bot IDs (maximum 16), enabling only the separate team catalog/metadata/
membership scope. Preparing or publishing code does not approve a setup or
configure a team-administration lead. Dwight must review the concrete
owner-authorized designation before privately configuring the existing bridge
environment and performing the normal single strict-idle activation. No tokens
or browser sessions are created. Example shape, not a live configuration:

```
BOTS_ADMIN_LEAD_IDS=["<explicitly-approved-existing-lead-id>"]
```

Removing a designation blocks new team-administration actions; creation still
requires its own exact owner approval. The authenticated owner can still
inspect/revoke its retained requests through `botAdmin.list/control`. The
machine remains the existing owner account's boundary. This is tool permission
enforcement, not new OS/process isolation against trusted same-account bots.

## Workflow

1. Designated leads’ `catalog` returns up to 100 bot identities/names/memberships per page and up
   to 32 team identities/names/colors/revisions; continue using `nextCursor`.
   It returns no paths, instructions, histories, files, secrets or model settings.
2. Any active named bot may `request` only `createBot` actions. Designated leads
   may also request the team actions below. `request` takes stable `operationId`, stable `executionOperationId`, and 1–6
   exact independent `actions`. Keep their text non-sensitive. Supported actions:
   `createBot` (name/purpose), `saveTeam` (name/color and existing ID/revision),
   `assignBot` (existing bot and source/destination team IDs/revisions).
   Actions sharing an affected team or bot snapshot require separate approvals.
   Creation and subsequent membership assignment use separate exact requests;
   no arbitrary forward references or implicit membership changes are accepted.
3. In the calling bot's DawarTodo **Settings → Bot and team setup**, the owner reviews
   the immutable actions, exact creation count and effective new-bot defaults.
   A fresh unchecked confirmation plus **Approve for one hour** grants only that
   request. `botAdmin.control` requires the existing authenticated owner relay
   route, the current revision and spec hash. Bot/peer text or a boolean is not
   approval. Approval never automatically starts a tool, send, queue or native turn.
4. `read` checks the original request. `execute` needs its exact request ID and
   original `executionOperationId`. Existing validated native provisioning,
   profiles/defaults, team operations, locks and durable receipts are reused.
   Child UUIDs are deterministically bound to caller/request/index, never supplied
   RPC names or paths. New bots are persistent single-thread bots, never workers.

Do not ask for secrets or copy credentials into purposes. Do not use a new request
to bypass an uncertain original creation. Read/reconcile its original receipt.
The tool cannot change model/sandbox/access configuration, archive/delete/Stop,
read chat/history, or mutate another bot's queues/schedules.

## Recovery and limits

Repeated request IDs require identical canonical actions and execution ID. Owner
control decisions use durable same-ID receipts; reconnects cannot renew twice.
The browser saves only the scoped non-sensitive decision journal and never
automatically retries approval. **Check the same decision** reuses its ID and
exact parameters. Failed/unknown acknowledgements cannot be replaced silently.

Before every unstarted effect, recheck caller eligibility, team designation when
needed, expiry/revocation and exact
new-bot defaults; immediately recheck before native `thread/start` and team CAS
commit. Owner revocation does not wait behind provisioning locks. It blocks later
effects and cannot undo one already started. Partial completion remains explicit.
Revision-fenced team changes preserve newer memory and all unselected members.
No approval renews itself. At most ten unresolved/unexpired requests per caller and
thirty owner list rows are returned; exact `read` remains available by request ID.

Known child receipts recover a lost parent acknowledgement without another
creation. A lost native start acknowledgement with no original thread mapping
remains uncertain; no native thread/start replay or duplicate bot is performed.
The existing local provisioning reservation/profile may remain when preparation
fails or approval is revoked during profile I/O. It is retained for diagnosis,
never deleted or retried with a replacement identity automatically. This is not
an all-or-nothing multi-action transaction and not forensic rollback.

Existing owner bot/team RPC behavior is preserved. Existing bot settings and
histories are untouched. The separate create-only default correction must keep
`newBotDefaults` and actual create/start settings agreeing; this feature does not
change its Fast/burst defaults or migrate legacy preferences.

The October 7 explicit human choice allows creation by any bot with approval;
team designation never substitutes for a creation approval. Retained workers/run
origins cannot use this named-bot provisioning channel.

Frontend and bridge/tool registrations require compatible release plus the normal
Dwight-owned idle backend activation. Public UI availability alone does not prove
the tool is installed, designated or a genuine owner approval was exercised.
