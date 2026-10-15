# Proactive initiative

Implements Dwight's approved plan
(`/home/dawar/bots/dwight-lead-developer-dawartodo/proactive-initiative-20261013/APPROVED_PLAN.md`,
SHA-256 `232b2d5b…07c`) with the October 13 amendment: **there are no quiet hours**, so delivery has no
time-of-day hold. The feature ships **disabled** (`enabled: false`).

## Pieces

| Piece | File | Runs in |
|---|---|---|
| Settings, ledger, dedup, limits, reply classification, result schema | `bot-bridge/initiative-ledger.mjs` | hub (`control.sqlite` records) |
| Review coordinator: scan, admission, acceptance, delivery, reconciliation, bot tool, Settings view | `bot-bridge/initiative-coordinator.mjs` | hub (`HubControls.tick`, every 5 s) |
| Private review and publication executor | `bot-bridge/initiative-node.mjs` (`runtime.privateReviews`) | assigned node (`BotRuntime`) |
| Hub → node transport | `HubRpc.nodeCall` (`rpc` frames; `initiative.node.*` accepted only from the hub, never from browsers, never cached) | gateway / agent |
| Settings UI | `app/bots/initiative-settings.tsx` (Settings tab, shown when the snapshot capability `proactiveInitiative` is set) | site |
| Owner outcomes | `bots_initiative` tool on the bot MCP server (forwarded to the hub as a hub tool) and first-reply classification in `HubControls.nativeEvent` | node → hub |

Records:
- **hub**: `initiativeItem`, `initiativeBot`, `initiativeReview`, `initiativePublication`, plus the meta keys
  `initiative-settings`, `initiative-ledger-version` and `initiative-next-delivery`.
- **node**: `privateReview`, `initiativeInjection`.

No migrations are needed: everything uses the existing `records` and `meta` tables.

## Behaviour

- **Admission (idle only).** The node's `localIdle` combines the memory-maintenance idle predicate (no active turn, queue,
  pending question, uncertain operation, run, collaboration, burst or active goal) with these checks: not holding the bot
  admission lock, no maintenance hold, no other review and no uncertain publication. It also takes a fresh native
  `thread/read` + queue + goal proof.
  - The bot lock is held only for the admission check and the fork, so user input is never delayed.
  - **Single-thread bots only.** The memory-maintenance predicate requires `executionMode === 'single-thread'`. Legacy-mode bots are never admitted. This applies to the whole feature, not just the pilot.
- **Private review.** The node runs `thread/fork` with the `PRIVATE_REVIEW` marker (`ephemeral`, `sandbox: read-only`,
  `approval_policy: never`, multi-agent off, `deferGoalContinuation`). Every MCP server the bridge configures is disabled.
  It then runs one `turn/start` with `sandboxPolicy: readOnly` and a strict `outputSchema`. Model, effort and Fast come from Settings (default GPT-6.1-Sol / medium / Fast off), with a 3-minute bound.
  - Dynamic tool calls get a failure result. Approval and input requests are rejected.
  - A started MCP or file-change item aborts the review as `invalid`.
  - Fork events are claimed before ordinary routing, so they never reach chat, typing, unread or notifications.
  - The fork is unsubscribed when the review ends.
- **User activity wins.** Input requests, `turn/started` and any activity advance cancel the review (`turn/interrupt` + release). The main conversation is untouched.
- **Stale rejection.** The hub captures the conversation revision, ledger version and node placement when the review starts.
  - At completion it re-probes. Any difference rejects the result: no ledger change, no message.
  - Failed, invalid and timed-out reviews produce no message and back off (5 min doubling, at most 6 h).
- **Ledger.** One item per underlying opportunity (normalized key, title or aliases).
  - The first bot is responsible; other bots are linked as contributors and never publish it.
  - Reviews may only add candidates, add evidence, mark items `resolved` or set the next review time. Owner decisions (approved, snoozed, dismissed, resolved) come only from replies or the bot tool.
  - A review that started before a decision cannot overwrite it.
- **Delivery.** All of these are checked before every attempt:
  - item still open
  - one reminder after 72 h unanswered; further reminders only with `changed_circumstances`
  - 2 per bot and 5 globally per Toronto calendar day (a counting boundary only, not a delivery hold)
  - randomized 3–5 minute spacing
  - node idle and conversation revision unchanged since the review. A changed revision marks the candidate stale, and a fresh review refreshes it.

  Limit-blocked results are `held` and revalidated, and expire after 24 h.
- **Publication.** The hub writes the record first. The node takes the bot admission lock, revalidates, then calls
  `thread/inject_items` with one assistant `message` item. This starts no main turn.
  - Only on confirmation does the node project the message: a live `codex item/completed` event anchored after the last native turn, the reconnect-history projection in `conversation-view.mjs`, the bot preview/`updatedAt` (unread) and a notice.
  - An ambiguous outcome stays `uncertain`. The node reconciles it by searching native history for the exact text and confirms if it finds it. It reports `absent` (and allows a retry, at most 3 attempts) only after the original call can no longer complete.
- **Replies.**
  - The first owner message after a proposal is classified deterministically: “yes, proceed” → approved, “next week” → snoozed 7 days, “leave it” → dismissed, “done” → resolved.
  - Anything else is left to the bot, which records it with `bots_initiative`.
  - Approved work then follows the bot's normal execution path.
- **Claude bots are gated.** The coordinator skips them; the node probe reports `provider-unsupported`.
  - The Claude backend rejects `forkPrivateReview` definitively.
  - A Claude implementation would need SDK session fork + a synthesized `ClaudeStore` turn for injection.

## Rollout (main session, with Dawar's go)

1. Deploy the hub and node together (the node advertises `privateReviews: true`; older nodes are reported as unsupported).
2. **Acceptance gates on the installed Codex** (plan requirement, not verifiable with fakes):
   - `thread/fork` with `ephemeral: true` + read-only sandbox works.
   - `thread/inject_items` appends the assistant item without starting a turn.
   - Whether injected items appear in `thread/turns/list`. If they do, the projection deduplicates by exact text.
   - The forked review is absent from `thread/list`/history after unsubscribe.
   - A loaded fork briefly counts as active for restart-maintenance idle proofs; a review is bounded to 3 minutes.
3. **Linux pilot.** In Settings, turn on **Pilot: only bots selected below**, select one bot, then enable.
   - Watch Last review, Next review, Failures and the counters.
   - Verify a hidden review, a proposal, “next week”/“leave it” persistence, a user-activity race and injection recovery (restart the bridge mid-injection).
4. Record token usage and cache savings from Settings (`reviewTokens`, `cachedTokens`) and outcome usefulness (accepted, dismissed, completed).
5. Widen coverage to all bots only after publication, recovery and permission enforcement are verified. Physical Mac acceptance remains deferred.

The legacy standalone bridge (`service.mjs`) has the node executor but no coordinator. `localExecutor` exists for wiring one if that path is revived.

## Tests

`bot-bridge/initiative.test.mjs` covers:
- disabled by default
- idle-only admission
- read-only fork parameters and refusal of tools, approvals and MCP
- hidden fork events
- cancellation on user activity
- stale-result rejection
- cross-bot deduplication
- reconciliation of uncertain and absent injections, without duplicates
- reply and tool outcomes, with newest-decision precedence
- spacing, daily limits, the 72-hour reminder and the Toronto day boundary
- result validation
