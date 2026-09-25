# Dawar Todo Bots

Bots use the owner's existing ChatGPT login in `~/.codex`. Each bot has one native Codex task and one private workspace in `~/bots/<initial-name>`. Display-name changes never move the workspace or replace the task. The six starter Markdown files are the source of truth for identity, behavior, and memory; their current contents are supplied on every new turn and steering message.

## Manager and worker agents

Every human-facing bot is also a persistent manager. Its existing conversation remains the relationship/context hub; substantial work is delegated to separate native Codex workers. No Codex Desktop management tools are required.

`manager.mjs` runs inside the systemd service and owns the orchestration state. `manager-mcp.mjs` is a small stdio MCP adapter configured only on manager thread start/resume. It connects to a mode-600 Unix socket at `~/.local/share/dawar-todo-bots/manager/manager.sock` with a per-manager, process-lifetime capability in its environment. Nothing is exposed on a public port or the browser bridge. Workers explicitly disable this MCP server. This is routing/ownership isolation within the same trusted Linux account, not a sandbox against agents that already have full VM access.

The manager receives six MCP tools:

| Tool | Operations |
| --- | --- |
| `codex_projects` | Native list, read, create, update, delete (empty projects only). |
| `codex_threads` | Discover/read native history; create, adopt, fork, message, steer, interrupt, rename, archive, restore, delete owned workers. |
| `codex_sections` | Native list/create/update/delete and worker placement. |
| `codex_worktrees` | Create/list/remove owned Git worktrees. |
| `codex_tasks` | Delegate, inspect status/receipts, collect results, answer worker requests, cancel, acknowledge uncertain execution. |
| `codex_organize` | Review the registry, set lifecycle state, preview/apply housekeeping. |

Mutations require a stable `operationId`; successful retries return the receipt. Interrupted operations are retained for inspection, never blindly repeated. A unique SQLite index protects worker/thread mappings. Native Codex is authoritative for projects, sections and transcripts; records add manager ownership, parent-worker relationships, roles, dependencies, task state, result summaries and worktree/branch information. Other human-facing bots cannot be adopted. Existing unrelated native tasks must be explicitly adopted before mutation; read-only discovery is available across the VM.

New delegated tasks use an isolated Git worktree by default. A manager can explicitly reuse a persistent specialist or choose `isolated: false`. Worktrees live under the manager state directory, use unique `codex/` branches unless one is supplied, and start from a resolved commit. Removal refuses active/uncollected tasks, uncommitted/untracked files, and commits not reachable from the specified `integratedRef`. Removal never forces Git or deletes the branch. Integration/merging is the manager's authorized repository work, not an automatic daemon side effect.

Tasks serialize per worker. Up to four workers run concurrently by default (`BOTS_WORKER_CONCURRENCY`, clamped to 1–16). Prerequisites must complete successfully; a failed prerequisite cancels dependent queued work. Blocking native approvals/questions stay answerable through the manager. Asynchronous questions hold the original task and its dependencies; answers continue the same task with a distinct native turn receipt. Workers do not appear as extra bots in the human sidebar.

Completion, failures and required input queue a durable callback to the manager. The callback waits for its conversation to be idle and for human-facing questions to resolve. Its hidden internal input wakes the existing conversation; the manager reviews native results and replies normally. Scheduled tasks retain their schedule context through worker callbacks so actionable findings can use the existing notification tool. The UI shows background task counts, and Stop cancels queued worker tasks, interrupts active workers and holds callbacks for the manager to inspect on the next human request. Browser closure does not stop worker execution.

On restart, the daemon restores the same manager MCP connections, reconciles worker creation and completed native turns, expires process-bound requests, and marks ambiguous execution uncertain. `codex_tasks status` exposes incomplete operation receipts. `acknowledge` records a reviewed uncertain task as interrupted without rerunning it. Reserved worktrees and worker mappings are retained for recovery.

Workers are placed in per-manager native Active Development, Waiting, Reference and Completed sections. Manual custom placement is preserved until lifecycle management is re-enabled with `setState`. Native section failures are exposed in worker records and do not prevent execution. Desktop's sidebar/project presentation remains best effort; the native project catalog and manager registry are the operational sources of truth. Housekeeping previews candidates and, with `apply: true`, archives temporary completed workers with collected results after seven days. It never removes worktrees or deletes threads automatically. Use the existing schedule tool for periodic housekeeping when requested.

Manager policy is refreshed every turn without overwriting existing identity or memory files. New bot profiles include the policy. All runtime data belongs in the existing state-directory backup; no separate database migration or global Codex configuration edit is needed. After upgrading the code, restart the service while bots are idle so existing managers receive the new MCP configuration. Health includes manager worker/task counts; `manager.state` JSON logs contain identifiers and lifecycle states, not prompts or credentials.

## Components

- `app/bots`: responsive conversation UI, native requests, local drafts/history, attachment transfer and schedule management.
- `bot-bridge/service.mjs`: Node **24+** service, Codex **0.156.1** stdio child, local SQLite, scheduler and notification delivery. No publicly listening VM port. Health is loopback only.
- `bots-relay`: separate Cloudflare Worker and SQLite Durable Object, using hibernating WebSockets. The VM and browser both connect outward.
- `/api/bots/session`: signs one-use, 60-second relay tickets after owner identity and origin checks. Sessions last 15 minutes and renew. Todo bearer tokens are rejected.
- `/api/bots/notifications`: independent machine credential, D1 outbox and per-owner subscription association. Existing Web Push subscriptions are claimed only with the authenticated browser's matching subscription keys.

The public operation contract is `lib/bots-operations.ts`; native bindings in `lib/codex-protocol` are generated from the installed binary. Browser requests cannot forward arbitrary native methods, thread IDs, or filesystem paths.

## Install and deploy

1. Use the existing Sites source workflow to reconcile this checkout. Install dependencies with `npm ci`.
2. Verify `node --version` is 24+ and the pinned binary exists at `~/.codex/packages/standalone/releases/0.156.1-x86_64-unknown-linux-musl/bin/codex`. Run that binary's `login status` as `dawar`.
3. Authenticate Wrangler with `npx wrangler login`, or provide a Cloudflare API token with Workers Scripts and account access plus the account ID in the environment. Set `SITE_ORIGIN` and `BOTS_MACHINE_ID` in `bots-relay/wrangler.jsonc` for the intended Site/VM.
4. Generate three independent random 32-byte secrets. Keep them outside the repository in a mode-600 file. Configure the relay's `BOTS_TICKET_SECRET` and `BOTS_MACHINE_SECRET` with `wrangler secret put --config bots-relay/wrangler.jsonc`. Deploy with `npm run bots:deploy` and use the URL returned by Wrangler, adding `/connect` and changing HTTPS to WSS.
5. In Sites runtime environment settings configure `BOTS_OWNER_EMAIL`, `BOTS_MACHINE_ID`, `BOTS_RELAY_URL`, `BOTS_TICKET_SECRET`, and `BOTS_NOTIFICATION_SECRET`. Mark both secrets secret. Deploy the saved Site version to apply them. The machine secret is never sent to Sites or a browser.
6. Copy `environment.example` to `~/.config/dawar-todo-bots/environment`, substitute the deployed relay URL and secrets, and `chmod 600` it. Set the initial Todo timezone explicitly. Browser sessions keep the runtime default timezone synchronized; each schedule stores its own timezone.
7. Run `npm run bots:install`, then `loginctl enable-linger dawar`. This installs and enables a user systemd unit using the current absolute Node binary. The state path defaults to `~/.local/share/dawar-todo-bots/state.sqlite`.
8. Publish the Site using its Sites build/package/source/save/deploy workflow. Migration 0030 adds the bot notification tables; compatibility initialization also creates them for local previews.
9. Open `/bots` signed in as the configured owner. Other users and ordinary Todo tokens cannot get relay tickets.

A missing relay configuration is shown explicitly in the UI. Local development uses ignored `.dev.vars` with `BOTS_DEV_AUTH=1` only on localhost, plus `BOTS_DEV_ORIGIN` on the local relay. Never enable this development flag in production. Do not package `.dev.vars`, environment files, SQLite databases, or credentials.

## Service operations

```sh
systemctl --user status dawar-todo-bots
systemctl --user restart dawar-todo-bots
journalctl --user -u dawar-todo-bots -f
curl http://127.0.0.1:47821/healthz
```

Health reports readiness, relay connectivity, bot count and pinned Codex version. A healthy Codex runtime can operate schedules while its relay is disconnected. Service logs are JSON and omit prompts, file contents, and credentials. `BOTS_DEBUG=1` adds native Codex diagnostics temporarily.

To upgrade: stop the service, back up the entire state directory and bot workspaces, install a chosen exact Codex version, change the pin and binary path, regenerate bindings (`npm run bots:protocol`), review every request/notification change, run the validation suite and a dedicated live bot, then restart. The service rejects an unexpected Codex version. Do not upgrade the shared Desktop app or mutate its account configuration as part of a Bots deployment.

To uninstall the service without deleting history, run `systemctl --user disable --now dawar-todo-bots`. Retain the SQLite state, `~/.codex`, and `~/bots` together; deleting just one breaks mappings. Use the bot Archive control to pause schedules while preserving files and history. Restoring a bot leaves its schedules paused until explicitly resumed.

## Recovery and delivery behavior

Operations are persisted before dispatch with stable retry IDs and fingerprints. Successful replies are replayed from receipts. A lost acknowledgement never automatically repeats a native action. Recovery searches the reserved workspace for an existing thread and reconciles user turns with Codex's `clientUserMessageId` / `clientId`. A bot whose setup was interrupted exposes **Retry setup**; this checks for an existing task before explicitly completing setup. Multiple matches require local reconciliation instead of guessing.

After a crash, unfinished scheduled runs remain uncertain until native history proves a terminal result or the owner reviews them. **I reviewed this run** releases the scheduling hold; it does not replay the old run. Run now creates a new explicit run. One bot executes serially, while other bots may run concurrently. Pending questions block scheduled work. Missed recurring occurrences coalesce to one catch-up run, with the next occurrence computed from the current time.

Native request IDs are namespaced by process epoch and persisted for browser reconnects. Resolving on one connection broadcasts resolution to the others. Process-bound requests expire on VM/runtime restart; a fresh turn may ask again. Asynchronous agent questions are stored as durable answer cards and answered in the same task. Managed Codex authentication is used; external-token refresh and attestation are not negotiated. Device biometric verification is not advertised on this Linux client. Commands/files/permissions, native questions, dynamic tools, current time, and MCP standard/OpenAI forms and URLs are handled.

Uploads are at most 100 MB per file, 12 files per message, in acknowledged 256 KiB chunks. Downloads are restricted to registered files in the mapped workspace. `bots_publish_artifact` copies a VM file into the bot's artifact directory, returns its registered link, and adds it to the conversation download shelf. Long responses/events are bounded at 32 MB; conversation history is paginated by 20 turns.

Notifications deduplicate reports by bot, finding key and content. Routine successful scheduled checks do not notify. Failures and requests for input do. Web Push is at-least-once transport: per-device delivery receipts and notification tags suppress duplicates; a provider acknowledgement lost during a crash can still cause a retry. A device must enable notifications in Settings and subsequently connect to Bots to associate the subscription with the verified owner. No provider delivery guarantee is implied when the browser or OS suppresses notifications.

## Validation

```sh
npm run bots:test   # SQLite/runtime, auth, relay, streaming and push outbox tests
npm run bots:check  # full TypeScript check and relay deployment dry run
npm test           # application production build and existing application tests
```

Also validate a dedicated bot against the actual app-server: create/retry, streamed messages, native question and two-device resolution, chunked attachment round-trip, Plan/steer/Stop, a harmless one-time schedule, archive/restore, reconnect and service restart. Verify desktop and mobile layouts in the browser. Use an owner device with Web Push enabled for the final real notification delivery check.
