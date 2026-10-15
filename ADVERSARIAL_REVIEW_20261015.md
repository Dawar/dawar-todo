# Adversarial review: DawarTodo as installed, 2026-10-15

This is step 8 of Dwight's plan (`TONIGHT_TEAM_WORK_INVENTORY_20261014.md`, "Adversarial review and installed completion"). It covers what shipped on Oct 14–15.

**Baseline**
- Production runs **ad6dc3a**: backend and website, deployed 13:41 UTC.
- The review started from `codex/bots` **9707091**, which is ad6dc3a plus the snapshot-models guard.

**Branch**
- `claude/adversarial-review-20261015`: 13 commits on top of 9707091.
- Nothing was deployed or restarted. No settings or production data were touched.

**Method**
- Six parallel area reviews read the code paths and proved defects with local probes.
- I reproduced each defect again before fixing it. Every fix has a test that fails on the old code.
- Defects that need an owner decision are recorded as `todo` tests that reproduce them, plus a recommended fix.

## Live system (read-only)

| Check | Result |
|---|---|
| `dawar-todo-bots` | active, running `portable/cli.mjs run both` from `backend-releases/ad6dc3a…`. `dawar-portable-site` runs from `web-releases/ad6dc3a…`. Front and tunnel are active. |
| `/healthz` 127.0.0.1:47821 | `ready:true`, `relayConnected:true`, `source:ad6dc3a…`, `role:both`, `siteReady:true`, maintenance `phase:open`, 32 bots, 7 Codex models, Claude `ready:true` with 5 models. |
| Gateway 127.0.0.1:3210 | 303 in 0.4–0.65 ms (3 probes). |
| Listeners | 3210, 3211, 3212 and 47821 are bound to 127.0.0.1 only. |
| Unit files | No secrets inline. Secrets come only from `EnvironmentFile`s, which are 0600 in a 0700 directory. `UMask=0077`. Release, hub and data directories are 0700 and `hub.json` is 0600. |
| Logs | The user journal has no entries for these units, so there were no logs to scan. In code, desktop and deploy logs carry only fixed categories, per the reviews. |
| SQLite | I read only table counts from `hub/application.sqlite` (read-only URI). Further reads of `control.sqlite`, `node-journal.sqlite` and `native-control.sqlite` were **blocked by the session's permission classifier ("Production Reads")**. Queue and inbox states in production were therefore not inspected. That is the next check to run with Dawar's permission. |

Before any change, the suites gave 734 tests: 710 pass, 0 fail, 24 skipped. tsc was clean. Lint had 1 pre-existing error.

## Fixed on this branch (each with a test that fails before the fix)

| # | Sev | Area | Defect | Commit |
|---|---|---|---|---|
| F-1 | High | Idle compaction | Idle compaction is ACKed and releases the bot lock before its `turn/started` arrives. During that window the work view reported `ready`, so portable admission dispatched Dawar's message or a scheduled run. The compaction guard then refused it definitively, and the source row was marked **failed**, not deferred. An in-flight compaction now counts as work. Test: `bot-bridge/context-compaction.test.mjs`. | 5416f18 |
| F-2 | High | Claude bots / Stop | If the SDK ignored interrupt, Stop only relabelled the turn after 15 s. The run kept working with every tool allowed, and its later output was consumed into the **next** turn. The grace timer now closes the SDK session, and a closed session's messages are dropped. Test: `claude.test.mjs`. | b51b450 |
| F-3 | High | Claude bots / security | Claude bots (allow-all tools, Bash) inherited the whole service environment. In production that includes `BOTS_MACHINE_SECRET` (hub/maintenance credential), `BOTS_STORAGE_SERVICE_SECRET` and `BOTS_NOTIFICATION_SECRET`, all in `~/.config/dawar-todo-bots/environment`. The fix drops `*KEY*/*SECRET*/*TOKEN*` names, as Codex's default shell policy does, then adds back the one Claude credential. This is defense in depth: a same-user process can still read `/proc/<ppid>/environ`. Test: `claude.test.mjs`. | 64f7769 |
| F-4 | High | Bots screen (restart) | The 9707091 guard was incomplete. A snapshot with no reachable node also lacks `defaults` and `account`. A journaled `bot` event re-adds the bot, and `ComposerSettings` then read `defaults.model` on undefined, so the screen boundary replaced the whole bots screen. The client now keeps the last known catalog and defaults, and `providerDefaults` has a fallback. Test: `tests/bot-client-recovery.test.mjs`. | bd601b6 |
| F-5 | High | Lazy panels / PWA | `React.lazy` caches a rejected import. With an offline PWA, or after a deploy that removed an old hashed chunk, Run history, Usage, the pickers or a whole screen failed again on every "Try again" until a hard reload. The new `lib/retrying-lazy.ts` starts a fresh import after a failure and is used for every lazy screen and panel. Test: `tests/retrying-lazy.test.mjs` (fails with plain `React.lazy`). | a8fa3f3 |
| F-6 | Medium | Desktop isolation | The node counts retired viewers (closed while their open was still settling) against the 8-viewer cap, but the hub does not. The next open threw synchronously, and the agent's socket handler closes the **shared node connection** on a synchronous throw, which drops every bot's sends, receipts and events. Only that viewer is refused now. Test: `tests/desktop-isolation.test.mjs`. | 3247bea |
| F-7 | Medium | Claude bots | If the SDK child died during `beginTurn`'s awaits, the prompt went to a dead input queue. `turn/start` resolved anyway, the turn stayed `inProgress` until restart, and the profile context was committed as delivered. It is now refused definitively, since nothing was sent. Test: `claude.test.mjs`. | b51b450 |
| F-8 | Medium | File viewers | In CRLF files a line-comment pattern swallowed the `\r`, so every comment line added a blank line. Lines were then shifted against line numbers and search targets, and the tail was dropped. Test: `tests/file-delivery-viewers.test.mjs`. | b3c2c6e |
| F-9 | Low-Med | Name messaging | The sender was excluded before tier matching, so bot "Atlas" messaging "Atlas" reached "Atlas Prime". Naming yourself is now refused. Test: `bot-bridge/bot-directory.test.mjs`. | b433418 |
| F-10 | Low | AI Elements | `subagentView` threw on a `collabAgentToolCall` without `agentsStates` or `receiverThreadIds`, which can happen in older cached history. There is no per-message boundary, so it took the screen down. Test: `tests/ai-elements.test.mjs`. | 8223ebc |
| — | — | Lint | Pre-existing `no-this-alias` error in `tests/task-pwa-recovery.test.mjs`. | 09c706f |
| — | — | Tests | `initiative.test.mjs` "replies update the ledger…" started failing at **14:00 UTC today**, on untouched 9707091 too. The fixture pins its clock at 2026-10-15T14:00Z, but `publishedAt` is the runtime's real `deliveredAt`. Hardening note: the coordinator compares a node-supplied `deliveredAt` against its own clock (`initiative-coordinator.mjs:314,341`), so after the split a node whose clock runs ahead would make replies be ignored. | 9dd61d9 |
| — | — | Tests | The deploy fixture's sequential `freePort()` calls could return the same port twice, which made `portable-deploy-roles` "cutover rollback" fail intermittently. | 2457dec |

## Status of open findings (Oct 15 evening, branch `claude/review-r2-r4`)

The first branch was merged into `codex/bots` and deployed as 141fe1c. Dawar asked for R-2, R-3 and R-4 to be fixed tonight.

| ID | Status |
|---|---|
| R-1 | **Intended behaviour, won't fix.** Dawar's policy is full access and full trust, so no tools or MCP servers are restricted anywhere, private reviews included. |
| R-2 | **Fixed** in bd2366b. Resume re-admits an automatic dispatch (queue, schedule or primary) that the node deferred before submission. The dispatch must still be `received` with no turn and on the current placement. Its original operation is kept, and the node's recovery loop submits it once Stop is released. The former `todo` test is now a real test, which asserts one start, the original operation ID and delivery. |
| R-3 | **Fixed** in 1fe7ba4. Deploy health requires every planned model to still be offered (superset), not an exact match. Before rollback stops a target that started, it drains the target through the target's own maintenance hold, seal and claim. The drain is bounded, always leaves the stop its own window, and is recorded in `rollback-drain.json`. The before-fix behaviour was confirmed with two end-to-end tests in `tests/portable-deploy-e2e.test.mjs`. |
| R-4 | **Fixed** in 504683b. Each bot's native snapshot read has a 4 s deadline. After it, the bot is answered from `portable_rpc_cache`, marked stale and not `nodeOnline`, and the whole snapshot reports `ready:false`. A node that missed the deadline is answered from cache at once, on that socket, until a read succeeds. Only one native snapshot read per bot is in flight, and concurrent snapshots for an owner share one build. Test: `tests/portable-snapshot-cost.test.mjs`. |
| R-5 to R-9 | Open. Out of scope tonight by Dawar's decision. R-5 keeps its reproducing `todo` test. |
| R-10 to R-26 | Open, unchanged. |

## Open findings, ranked (as found; see the status table above)

### High

**R-1. Codex "read-only" private initiative reviews still have the user's own MCP servers.** *Status: intended behaviour under Dawar's full-trust policy; won't fix.* This was latent anyway, because initiative is disabled in production.
- **Where:**
  - `bot-bridge/initiative-node.mjs:42-49`: `PRIVATE_REVIEW_CONFIG` disables only the four bridge-configured servers.
  - `bot-bridge/codex.mjs:27`: the app-server loads `~/.codex/config.toml`.
- **Failure:** that config defines `node_repl`, `android_control` and `otp`, plus plugins. MCP servers run outside the Codex sandbox, and with `approvalPolicy:'never'` nothing prompts. The `mcpToolCall` guard fires on `item/started`, after the call has already gone out.
- **Risk:** a prompt injection in the review packet (peer or bot text) could run code, operate the phone or read OTP codes.
- **Claude reviews are fine:** `tools: []`, `mcpServers: {}`, `settingSources: []`.
- **Fix:** run private reviews on a dedicated app-server with an empty `CODEX_HOME` (or an explicit override that replaces the whole `mcp_servers` table). Add `strictMcpConfig: true` to Claude reviews as hardening.
- **Test:** `initiative.test.mjs` with a temporary `CODEX_HOME/config.toml` that defines an extra server. Assert that none are enabled.

**R-2. Stop during a pre-native deferral wedges a bot's queue permanently.** *Status: fixed in bd2366b (Resume re-admits the deferred dispatch).*
- **Where:**
  - `portable/agent.mjs:276,300-306`: a deferred logical command stays `received`, and `execute` returns silently while `canAdmit` is false.
  - `portable/hub-controls.mjs:298-301`: Resume, `work.resume` and Send are refused while a mailbox row is non-terminal, and `queue.delete` is refused while the row is `dispatching`.
- **Failure:** any transient pre-submission deferral (queue-list read failure, missing team ack, active Goal) followed by Stop needs manual database repair.
- **Fix:** when a logical command is still `received` with no local operation and the control is stopped, the node sends a terminal "withdrawn before submission" receipt so the hub re-queues the item. An alternative is to let Resume re-admit an outstanding `received` row.

**R-3. A rollback after a healthy-but-"unhealthy" deploy SIGKILLs in-flight turns with no drain.** *Status: fixed in 1fe7ba4.*
- **Where:** `portable/deployment-linux.mjs:109,126,347-351,190-195`.
- **Failure:** `newHealthy` requires exact equality with the old process's model list. Any Codex catalog change between `prepare` and start therefore fails health for the full 300 s window, even though the target is admitting turns. `rollback` → `stopAndWait` then issues `systemctl stop`, followed by SIGKILL.
- **Fix:**
  - Compare models as a superset, or warn instead of failing.
  - Have rollback take the maintenance hold and drain claim before stopping, as the forward path does.
- **Test:** `tests/portable-deploy-roles.test.mjs`. The new stand-in reports one extra model and has one active turn.

**R-4. A connected but unresponsive node holds every bots-screen snapshot for 15 s per bot, and the cache is ignored.** *Status: fixed in 504683b.*
- **Where:** `portable/hub-rpc.mjs:44-56,136-145`.
- **Failure:**
  - The cache is used only when there is no socket.
  - Four workers each wait out a 15 s timeout, so 32 bots take about 120 s and return zero bots.
  - A healthy node's bots share those workers.
  - Concurrent snapshots are not coalesced.
- **Proof:** a probe with 8 bots and a silent socket took 30 s and returned 0 bots, `stale:true`.
- **Fix:**
  - Answer from `portable_rpc_cache` (marked stale) after a short per-node deadline, and track each node's liveness separately.
  - Share one in-flight snapshot per owner.
- **Test:** `tests/portable-snapshot-cost.test.mjs`.

### Medium

**R-5. A transient failure while preparing queued input becomes `unknown`/uncertain and is never retried.** Reproduced by a `todo` test in `tests/portable-send-reliability.test.mjs`.
- **Where:** `portable/agent-admission.mjs:73,81,87,96,101`. `importAttachment`, `prepareReply` and `messageInput` run before `journal.prepare` but are not converted to deferrals.
- **Failure:** a transient attachment download failure ("Cloud download failed. Retry the same attachment ID.") leaves the item needing manual confirmation, although nothing was sent. `agent-bursts.mjs:57` has the same gap.
- **Fix:** classify retryable errors (network, timeout, 5xx, "Retry the same attachment ID") as `defer` with a bounded retry count, and keep integrity errors (checksum mismatch, identity conflict) terminal. Unbounded deferral could stall a queue silently, so this needs an owner decision.

**R-6. A Stop-held Claude queue drains by itself after an idle unload or a restart.**
- **Where:** `bot-bridge/claude.mjs:547` (`threadResume` → `drainSoon`).
- **Failure:** the in-session hold (`endings`/`lastStatus`) is lost when the session object goes away. That happens after a 10-minute idle unload or a restart, and also now after F-2 closes a stuck run. The first `thread/resume` then starts the queued prompt.
- **Related:** `thread/queue/add` drains right after a stopped turn, because `endings` is captured at add time.
- **Fix:** persist `queueHeld` on the thread record in `complete()`, clear it on the next explicit `turn/start` or `thread/queue/start`, and check it in `drainSoon`.

**R-7. Escalated stop can leave the service down.**
- **Where:** `portable/deployment-transaction.mjs:93-97` waits 60 s while `TimeoutStopSec=120`, and `deployment-linux.mjs:374-381` skips `ensureRunning` while a stop job exists.
- **Contradiction:** DEPLOY.md:85 says a start is queued behind the stop job.
- **Proof:** a probe ended in `reconciliation-required` with no start issued.
- **Fix:** in `ensureRunning`, run `systemctl start --no-block` (it queues behind the stop), and wait `TimeoutStopSec`+margin after escalation.

**R-8. A controller crash after `stop-intent` leaves the service down until someone relaunches the same plan.**
- **Where:** `portable/deploy-cli.mjs:52`. `systemd-run` has no `Restart=`, and there is no SIGTERM handling.
- **Behaviour:** resume is idempotent, but a new `prepare` refuses while the unit is inactive. A stale lock with a different operation ID also blocks everything (`deployment-transaction.mjs:52`, not documented).
- **Fix:** `--property=Restart=on-failure` on the controller unit, plus a runbook line.

**R-9. An unplanned start during `prepareStart` gets stopped, possibly with SIGKILL.**
- **Where:** `deployment-linux.mjs:189`, `deployment-transaction.mjs:115`.
- **Contradiction:** the yield contract, which covers only `waitOldExit`.
- **Fix:** treat a MainPID that appears during `prepareStart` like the earlier yield: leave it running and stop the controller with `yielded`.

**R-10. The 60 s team-reference cache reopens the "Sian" failure.**
- **Where:** `portable/agent.mjs:416-428`, `bot-bridge/runtime.mjs:1587`.
- **Failure:** a slow attachment `messageInput` (up to 120 s per file) pushes the send past the cache window. The send then asks the hub *after* `journal.prepare`, and a lost ack fails the item terminally.
- **Fix:** pass the preflight reference into the send explicitly.

**R-11. Initiative records are never pruned and keep copies of Dawar's messages.** Latent, since initiative is disabled.
- **Where:** `initiative-node.mjs:178,291`. Extraction batches (about 24k characters) and outputs (up to 64 KB) accumulate, and each tick scans O(bots × rows).
- **Fix:** retention, for example dropping `batch` once reviewed and pruning resolved records after N days.

**R-12. Managed desktop creation fails outright on hosts without IPv6.**
- **Where:** `bot-bridge/desktops/manager.py`, the `managed()` VNC probe raises `ValueError` on EAFNOSUPPORT/EADDRNOTAVAIL.
- **Status:** latent on this host. The Mac and other nodes need checking.
- **Fix:** skip the `::1` probe on those errno values.

### Low

| ID | Finding | Where | Fix |
|---|---|---|---|
| R-13 | `reconcileAcceptedInbox` skips accepted rows from an older thread or an archived bot, but `counts().acceptedOrUnknown` still counts them. That may block a drain. | `bot-bridge/turn-state.mjs:319-321`, `runtime-maintenance.mjs:99` | Align the two predicates. |
| R-14 | A compaction `reset()` can be overwritten by an in-flight `commit()`, so the profile is not resent after compaction. | `bot-bridge/context-delivery.mjs:28,64-70` | Add an epoch counter checked in `commit`. |
| R-15 | The generated hub unit escapes environment values for the wrong context. `$`→`$$` is wrong in `Environment=`, newlines are unescaped, and the path is unquoted. The fake systemd hides it (`$$`→`$`). | `portable/deploy-plan.mjs:29,94`, `tests/helpers/fake-systemd.mjs:25` | Fix the fake first, then quote correctly. |
| R-16 | Chapter changes made offline never retry until the next mutation or load. An owner-mismatch receipt blocks the queue head. `pending` is unbounded in memory. | `app/bots/chapter-store.ts:120-129,49-50` | Add an `online` listener, treat the mismatch as terminal, and cap `pending`. |
| R-17 | Claude bots bypass the compaction admission guard, so a message is steered into a `/compact` turn. Nothing is lost. | `bot-bridge/provider-router.mjs:72-79` | Call the guard for Claude too. |
| R-18 | The shared instructions contradict each other. `INITIATIVE_INSTRUCTIONS` ("add at most one suggestion") now reaches isolated scheduled runs that are told to stay quiet when nothing changed. "Every bot on this team" is sent to bots with no team. Older bots' `AGENTS.md` keeps the old text next to the new. | `bot-bridge/profiles.mjs:24,37-38` | Keep the initiative text out of `RUN_INSTRUCTIONS`, and condition the team sentence on having a team. |
| R-19 | Initiative is not fully inert when disabled. `INITIATIVE_TOOL` stays in every bot's tool list. `tick()` still polls and reconciles old reviews and publications, though it makes no model calls. The extraction catalog shows bot A's loose-thread titles to bot B (single owner, so cross-bot only). | `manager.mjs:279,285`, `initiative-*.mjs` | Gate the tool and the tick on the setting. |
| R-20 | Notification click accepts a URL on another origin. This is only exploitable if a push payload ever carries bot-authored URLs. | `public/sw.js:316-323` | Require a same-origin URL. |
| R-21 | `MainStopButton` sends `turn.interrupt {scope:'main'}` with no turn ID. A turn that finishes while the dialog is open lets Confirm stop the next one. | `app/bots/run-controls.tsx` | Send the shown turn ID. |
| R-22 | Any rejection from `execute` (for example "bot absent or archived") closes the agent's shared hub socket. Reconnect replays `received` commands, so this can loop. | `portable/agent.mjs:208,252` | Settle that one command terminally instead. |
| R-23 | `frontendFilesUnchanged:true` is written without a check, so a web/backend SHA mismatch is never detected. The Mac `bundleManifestSHA256` is never compared at install. `checkHealth` with a missing previous activation stays `pending`. | `deployment-linux.mjs:183`, `portable/mac-agent/controller.mjs:56,76,181` | Verify, or drop the claim. |
| R-24 | An `events` RPC with one event over 900 KB returns empty and jumps the cursor. No first-party caller exists. | `control-store.mjs:219-220` | Return at least one event. |
| R-25 | Hung desktop opens (TCP connect with no timeout) stay retired forever and lower the per-node cap by one each. F-6 removes the socket-close consequence. | `bot-bridge/desktops.mjs:690` | Add a connect timeout. |
| R-26 | Name tiers resolve `"21"` to extension #21 before a bot literally named "21", and the prefix tier guesses (`"bo"` → Bob). | `bot-bridge/bot-directory.mjs` | This is a design choice. Consider requiring `#` for extensions. |

## Checked and held up

- **Dispatch and recovery**
  - One non-terminal mailbox row per bot, re-checked inside the dispatch transaction, so dispatchers cannot race.
  - The deferral guard (received, same fingerprint, no local operation) makes a resend after `prepare` impossible.
  - A restart with a `dispatching` row and no operation becomes `unknown` and is never resubmitted.
  - Lost receipts recover through the original operation.
  - Inbox reconcile re-checks under the lock, backs off, and settles only terminal native facts.
- **Idle compaction, busy-bot safety**
  - `start()` re-runs `blocker()` after every await, under the same bot lock as sends and portable admission.
  - The blocker covers active turns, questions, Goals, the queue, the inbox, runs, Stop, plans, bursts and uncertain operations.
  - One attempt per usage generation; a failure is never retried in a loop.
  - At most one compaction per tick, so there is no herd across 32 bots.
  - The idle clock persists across restarts.
  - Pressure uses `last.totalTokens`, not the cumulative total.
- **Stop UI**: `open` is cleared before submit, so a double confirm is a no-op. The workspace is keyed by bot, so there is no stale-bot closure. A saved Stop only re-checks its original ID.
- **Sender badges**: shown only when the `sourceSubmissionId` matches. Unknown senders stay neutral.
- **Composer double submit**: IME composition and repeat-Enter are ignored, and the `committing` guard is set synchronously.
- **Desktop access**: owner-checked placement; 256-bit single-use tickets with a 30 s expiry, bound to bot and parent; epoch and socket checked per frame; 8 MB output caps; no secrets or frames in logs; port allocation under an `fcntl` lock.
- **Files and artifacts**: `localFileLink` is display-only and rejects traversal. Artifacts are owner- and bot-scoped, content-addressed, opened with `O_NOFOLLOW`, served as `attachment` with `nosniff`, and streamed. Viewers render React text only.
- **XSS**: rehype-sanitize plus URL transforms; mermaid in `strict` mode with an SVG DOMPurify profile; document previews in a sandboxed CSP `srcdoc`.
- **Deploy**
  - The lock covers every role.
  - `savePrivate` uses temp file, fsync and rename at 0600.
  - Releases are verified by manifest hash.
  - No shell injection: commands use `execFile` arrays and unit names are regex-checked.
  - Receipts are redacted.
  - The hub unit has no machine secret.
  - Split: `run hub` and `run both` cannot share one store, and the runner only dials out.
- **Mac releases**: Ed25519 over the canonical full record, downgrade blocked, archive size and sha256 checked, Sparkle EdDSA, tree path checks, atomic install after re-verification.
- **Claude routing and creation**
  - `claude:` prefixes; a crash mid-turn is never replayed.
  - A queue item is removed before it starts.
  - Hub creation is owner-only, the bot ID equals the operation ID, and slugs are path-safe.
  - Name messaging is scoped by owner placement.

## Not covered

- **Production queue and inbox states**: the SQLite reads were blocked (see the live table above).
- **Physical device acceptance** (iPhone PWA, Mac app): not done.
- **Real Codex 0.162 compaction timing**: whether and how fast `turn/started` arrives for compaction. This sets the size of F-1's window in production; F-1 removes the window either way.
- **Voice and memory isolation (8b097dd)**: not reviewed in depth.
- **The plan's 25-point implemented/retained ledger**: remains with Dwight and the main session. This review covers the Oct 14–15 deliverables only.

## Verification

**First branch (`claude/adversarial-review-20261015`, merged as 141fe1c)**
- `npm run test:all`: 744 tests, 718 pass, 0 fail, 24 skipped, 2 `todo`.
- tsc clean. Lint: 0 errors.

**Branch `claude/review-r2-r4`, the R-2, R-3 and R-4 fixes**
- `npm run test:all` (`npm run build` plus both suites): 748 tests, **723 pass, 0 fail**, 24 skipped (pre-existing, documented in TESTING.md), 1 `todo` (R-5, reproducing an open defect).
- `npx tsc --noEmit`: clean.
- `npm run lint`: 0 errors (27 pre-existing warnings).
- Every fix's test was confirmed to fail with the fix reverted.
