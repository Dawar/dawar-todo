# Proactive initiative

This implements Dwight's approved plan
(`/home/dawar/bots/dwight-lead-developer-dawartodo/proactive-initiative-20261013/APPROVED_PLAN.md`,
SHA-256 `232b2d5b…07c`), with two changes:
- **October 13 amendment:** there are no quiet hours.
- **October 15 redesign:** the feature works the same on Codex and Claude bots, and its first job is **loose threads**.

The feature ships **disabled** (`enabled: false`).

## What it is for

Dawar's goal is that nothing he mentions gets lost: a client, a new idea, an intention, an open question or a decision in progress that never reached a conclusion. Each of these becomes a **loose thread**. A loose thread comes back at the right time as a short proposal from the bot. That proposal quotes his original words and suggests one concrete next step.

The general initiative reviews (follow-ups and opportunities) still exist, but loose threads take priority.

## Pieces

| Piece | File | Runs in |
|---|---|---|
| Settings, ledger, loose threads (dedup, timing, priority, resolution), limits, reply classification, result schema, proposal text | `bot-bridge/initiative-ledger.mjs` | hub (`control.sqlite` records) |
| Coordinator: scan, triage, admission, job acceptance, delivery, reconciliation, bot tool, Settings view and actions | `bot-bridge/initiative-coordinator.mjs` | hub (`HubControls.tick`, every 5 s) |
| Mention capture: owner-only reader with cursor, extraction prompt/schema, quote validation | `bot-bridge/initiative-mentions.mjs` | assigned node |
| Bounded review packet | `bot-bridge/initiative-packet.mjs` | assigned node |
| Private jobs (both providers), projection delivery, next-turn awareness | `bot-bridge/initiative-node.mjs` (`runtime.privateReviews`), `context-delivery.mjs` | assigned node (`BotRuntime`) |
| Provider execution | `codex.mjs` `startPrivateThread`, `claude.mjs` `privateRun`, `provider-router.mjs` | assigned node |
| Hub → node transport | `HubRpc.nodeCall` (`initiative.node.*`, capability `privateReviews: 2`) | gateway / agent |
| Settings UI | `app/bots/initiative-settings.tsx` (`initiative.read`, `initiative.configure`, `initiative.thread`) | site |
| Owner outcomes | `bots_initiative` tool, first-reply classification in `HubControls.nativeEvent`, and Settings actions | node → hub, site → hub |

Records:
- **Hub:**
  - `initiativeItem`: the kind `loose-thread` adds `category`, `entity`, `importance`, `mentions[]`, `lastTouchedAt`, `resurfaceAt` and `resolution`.
  - `initiativeBot`: adds `mentionCursor` and `lastExtractionAt`.
  - `initiativeReview`: the field `kind` is `extract` or `review`.
  - `initiativePublication`.
  - Meta keys: `initiative-settings`, `initiative-ledger-version` and `initiative-next-delivery`.
- **Node:** `privateReview` (jobs) and `initiativeDelivery`. `initiativeDelivery` replaces the older `initiativeInjection`.

No migrations are needed, because nothing was ever enabled.

## Loose threads

### 1. Mention capture (`extract` job)

**When it runs.** An idle bot with any activity since its last extraction gets an extract job. Extract jobs run before reviews.

**What the node reads.**
- It reads only turns newer than the bot's `mentionCursor`.
- With no cursor yet, it reads only the last `mentionLookbackHours` (default 72 h). It never rescans the full history.
- It takes **owner-authored messages only.** These are excluded:
  - messages from `schedule:`, `peer:`, `peer-exchange:`, `manager-notice:` and `secure-receipt:` clients
  - messages from `initiative` clients
  - messages that begin with a verified bot source
  - messages whose submission source is not `user`

  Bot text is never a source.
- Successful bot tool calls that look conclusive (todo, task, schedule, message, mail, artifact, queue) are listed separately, as resolution evidence only.

**Batch bounds.** A batch holds at most `extractionBatch` (40) messages and `extractionChars` (24k) characters. A batch that does not fit sets `more`, and the next admission continues from the cursor. With no new owner messages, the cursor advances **without a model call**.

**The model.** A small model (`extractionModel` `gpt-6-luna`, `claudeExtractionModel` `haiku`, effort `low`) receives:
- the batch
- the open cross-bot loose-thread catalog, so it can reuse ids
- the bot directory, so it can pick a better-fitting bot

It returns `mentions` and `resolutions`.

**Validation, on the node, against the exact batch.**
- Every mention must cite a message in the batch, or it is dropped.
- The quote must be Dawar's words from that message. Otherwise the message's own opening is used instead.
- Resolutions may only name tracked items.

**Source references.** Each mention keeps `{botId, threadId, turnId, itemId, at, quote}` and the source string `mention:<bot>:<turn>:<item>`.

**Cursor.** The cursor is committed only when the hub accepts the result. A failed extraction is retried from the same place.

### 2. Dedup and responsibility (`applyMentions`)

- **Matching.** A mention matches an existing thread by item id first, then by key or alias, then by the same entity with a similar title (Jaccard ≥ 0.4). So the same client mentioned to two bots becomes **one item with both mentions**. A different topic about the same client stays separate.
- **Responsible bot.** The bot where the thread was mentioned is responsible, unless the extraction names an eligible `better_bot_id` (for example, a client goes to the communications or sales bot). Other bots become contributors.
- **Repeated mentions.** A repeat updates `lastTouchedAt`, raises the importance and pushes `resurfaceAt` later.
- **Reopening.** Dawar mentioning a resolved or dismissed thread again *after* it closed reopens it.

### 3. Resolution

A thread is resolved only on conclusive evidence:
- **Extraction:** a todo or task created or completed, a decision stated, a message sent, a meeting scheduled, an artifact delivered, or Dawar saying it is done or dropped. Each is recorded with `resolution {kind, evidence, at, source}`.
- **Review:** a `ledger_updates` entry with status `resolved` and a note. Its kind is `concluded`.
- **Owner:** the reply “done”, `bots_initiative record resolved`, or Settings → Done. Its kind is `owner-done`.

A resolution never overrides an owner decision that is newer than its evidence. Everything else stays open, with its `lastTouchedAt`.

A review can propose, update or resolve a loose thread but can never create one.

### 4. Resurfacing

**When a thread is due.** `resurfaceAt = lastTouchedAt + delay`.

| Category | High | Medium | Low |
|---|---|---|---|
| client, commitment | 2 h | 6 h | 24 h |
| person, company | 3 h | 8 h | 24 h |
| question, intention, decision | 4 h | 12 h | 36 h |
| idea | 12 h | 36 h | 72 h |

- **Time-sensitive** threads are due after at most 2 h.
- **Named deadline:** a thread with a deadline is due 6 h before it, and at least 1 h after the mention.
- **Snoozes:** a woken snooze is due immediately.
- **After a proposal:** the plan's rule applies. The thread waits 72 h for a reply, then gets one reminder, and after that comes back only on `changed_circumstances`.

**Priority** is importance × category weight, rising by up to 4× as the thread becomes overdue (over the following 72 h), plus a time-sensitive bonus. It orders:
- loose threads inside a review packet
- reviews in the backlog: due loose threads before follow-up, activity and baseline reviews
- pending deliveries: loose threads first

**Limits.** The usual limits still apply: 2 per bot and 5 globally per Toronto day, with 3–5 minutes between deliveries. Loose threads get priority inside them: the last `looseThreadReserve` (1) global slot of the day is kept for a due loose thread (`reserved-for-loose-threads`, a held state).

**The review's question set** starts with loose threads:
- What did Dawar mention that has not led to anything conclusive?
- Which is most valuable or time-sensitive now?
- What is the concrete next step?

**Behaviour, set in the prompt only.** The review frames each bot as competing, on merit, for Dawar's limited attention. It should:
- bring the most valuable, specific, evidence-backed proposal it can, or nothing
- consider proposing more ownership or responsibilities that would make it more useful to him (question 6)
- stay honest: no exaggeration, no padding, no undermining other bots, and a cited source for every claim

There is no scoring or arbitration machinery. The delivery limits remain the hard cap. The matching shared bot instructions live in `profiles.mjs` and are maintained by the main session.

**The proposal text** is built by the bridge, not by the model:

> On Tuesday you mentioned to Connie: “call Acme about their renewal”
>
> *(the bot's message)*
>
> **Proposed next step (create a todo):** …
>
> _Ref …: reply “yes, proceed”, “next week”, “leave it” or “done”._

A `loose-thread` contribution must name its `item_id` and a `proposed_action`: todo, draft-message, schedule, research, drop or other.

### 5. Settings

Settings → Proactive initiative now also has:
- **Track loose threads** and **Triage** switches.
- **Token use:** reviews and mention capture, today and in total.
- **Loose threads list:** open threads by priority, plus the last 10 closed ones. Each row shows:
  - title, category, importance and status
  - whether it is due
  - the quote, the bot it was said to and its age
  - how many times it was mentioned
  - which bot follows up
  - the resolution, once there is one

  Each open row has **Done**, **Next week** and **Leave it** (`initiative.thread`: owner only, idempotent by operation id).

Replies (“next week”, “leave it”, “done”, “make it a todo”) and the bot tool work as before.

## Review and execution: provider-neutral

### Review input

The review input is a **bounded packet** (`packetTokens`, default 12k; bounds 3k–20k; target 5–15k). It is built on the node from bridge-owned data, the same way for both providers:
- role and priorities
- IDENTITY, SOUL and USER files, then MEMORY (through `profiles.mjs`)
- schedules, queue and other bots (from the hub brief)
- recent artifacts
- other ledger items
- loose threads, with their quotes, due flags and priority
- recent conversation: from `thread/turns/list`, which ClaudeStore serves for Claude bots. It includes Dawar's messages, peer and system messages (labelled), the bot's final answers and tool names only.

Stable sections come first, for prompt caching. Every section is clipped to its share, and the conversation takes whatever room is left.

### Execution

Each job runs once, tool-free, in a fresh disposable session on the bot's own provider. The review uses the bot's own model unless `model` or `claudeModel` overrides it.
- **Codex:**
  - It starts an ephemeral `thread/start` (read-only sandbox, approval `never`, no `dynamicTools`, multi-agent off, every bridge MCP server disabled, cwd `<root>/.initiative-private`) and one `turn/start` with `outputSchema` and `sandboxPolicy: readOnly`.
  - Any tool item (command, MCP, file change, web search, dynamic tool) aborts the job as `invalid`. Tool calls and approvals are refused.
  - Job events are claimed before ordinary routing, so they never reach chat, typing, unread or notifications.
  - The thread is unsubscribed at the end.
- **Claude:**
  - It runs an Agent SDK `query` with `persistSession: false`, `tools: []`, `allowedTools: []`, `mcpServers: {}`, `settingSources: []`, `maxTurns: 3` and `outputFormat: {type: "json_schema"}`.
  - `canUseTool` denies everything except the SDK's own `StructuredOutput`.
  - The run is not a loaded session and writes no ClaudeStore turn or notification.
- **Main conversation and idle proofs:**
  - The main conversation is never forked, never read into a model whole and never written.
  - A Claude job is invisible to idle proofs.
  - A Codex job thread counts as a loaded active thread for restart-maintenance idle proofs for at most the job's time bound (3 minutes), so a restart waits for it. That is bounded and accounted for.
- **Settings:** model, effort and Fast come from Settings, with a 3-minute bound (2 minutes for extraction).
- **User activity:** user activity cancels a review. An extraction of past messages may finish.
- **Stale results:** the hub captures the conversation revision, the node placement and a digest of the ledger items the review saw. Any change to these rejects the result. Unrelated ledger changes (for example another bot's extraction) do not.

### Triage

Triage is an optional setting (`triage`, off by default) and costs no tokens. When it is on, only bots with a signal beyond the baseline timer are reviewed, best first, at most `triageMaxReviews` per scan. Signals are a due loose thread, a due follow-up, new activity and open items.

A model-based triage was not needed: every signal is bridge-owned.

### Delivery

`thread/inject_items` is gone. The node records an `initiativeDelivery` under the bot's admission lock, after the idle and revision check, and projects it:
- a live `codex item/completed` event anchored after the last native turn
- the reconnect-history row in `conversation-view.mjs`
- the bot's preview and `updatedAt` (unread)
- a notice

Delivery is idempotent by publication id. After an ambiguous RPC, `reconcile` reads the local record under the same lock, so `absent` is definitive (at most 3 attempts).

### Next-turn awareness

The bot never wrote the proposal in a model turn. So the next send in that conversation carries an `initiativeProposals` context entry, through `ContextDelivery.prepare`. The entry contains the exact text, when it was sent, the item id, and an instruction to record Dawar's decision with `bots_initiative`. It is marked seen only after the native start or steer is acknowledged, so it is delivered once.

### Claude gating

The Claude gating is removed. Both providers are eligible, and the node reports `provider-unsupported` only when it cannot run the job (for example, Claude is not enabled on that machine).

## Cost estimate

Computed from production read-only. SQLite files were copied and queried as copies; Codex rollouts in `~/.codex/sessions` were streamed. The numbers cover Oct 8–14 (Toronto days), and 30 bots are active (29 Codex, 1 Claude).

**Context sizes:**
- **Codex:** each bot's current conversation context (the last model call's input) has median 233k, p90 345k and max 371k tokens.
- **Claude:** claudia's is 513k.
- **Total:** about 7.13M tokens per round of reviews over all bots.
- **Caching:** 96% of Codex input is cached.

| | Old: `thread/fork` of the conversation | New: bounded packet |
|---|---|---|
| Input per review | the whole context: median ≈ 245k, max 513k | ≤ 12k (default; typical 6–12k) |
| One round over 30 bots | ≈ 7.1M input tokens | ≤ 0.36M input tokens (≈ 20× less) |
| At the 2 h baseline, 12 rounds/day | ≈ 86M input/day (≈ 10% on top of the bots' ≈ 844M/day) | ≤ 4.3M input/day (≈ 0.5%) |
| Uncached input (Codex 96% cache hit on forks) | ≈ 3.4M/day | ≤ 4.3M/day (packets change between reviews) |
| Claude (opus), per review | ≈ 513k input | ≤ 12k input |

**Mention capture.**
- **Volume:** over the week, Dawar wrote 581 owner messages (≈ 83 a day) totalling ≈ 296k characters (≈ 42k characters ≈ 10.5k tokens a day; median 87 characters). The busiest day had 115k characters.
- **Per run:** each run with new messages costs ≈ 1.5–3k tokens of fixed prompt, catalog and directory, plus the messages, plus ≈ 300 output tokens. A run with nothing new costs nothing.
- **Per day, on `gpt-6-luna` (or Claude haiku):**
  - ≈ 40 runs a day: ≈ 100–150k tokens a day.
  - Worst case, one run per owner message (83): ≈ 260k tokens a day.

**Takeaways.**
- Total review input drops about 20×.
- Uncached input is about the same as with forks, because forks were heavily cached.
- The large gains are on Claude and in subscription usage windows that count cached input.
- Enabling triage cuts baseline reviews further.

## Rollout (main session, with Dawar's go)

1. Deploy the hub and node together. The node advertises `privateReviews: 2`; older nodes are reported as unsupported.
2. **Live acceptance checks.** These are not verifiable with fakes:
   - **Codex ephemeral thread:** `thread/start` with `ephemeral: true` + `developerInstructions` + read-only sandbox + `outputSchema` returns a schema-valid final message. It is absent from `thread/list` after unsubscribe. A job thread that ends in `systemError` must not block native recovery (it is unregistered).
   - **Codex tools:** the review model attempts no built-in tool, since any attempt makes the job invalid. If it does, a Codex config key that disables built-in tools for the job thread must be found.
   - **Claude query:** `tools: []` + `outputFormat` with the installed SDK/CLI returns `structured_output`. Confirm that `StructuredOutput` is the only tool requested, and that no session file appears under the Claude config dir.
   - **Projection:** a delivered proposal appears live, after reload, in the preview/unread state and as a notice, on one Codex bot and on claudia.
   - **Next-turn awareness:** the next turn's context contains the proposal, and the bot records “yes, proceed” and “next week” through `bots_initiative`.
   - **Mention capture on real traffic:**
     - Owner-only: no peer or schedule text becomes a thread.
     - Quotes are verbatim.
     - The same client mentioned to two bots becomes one item.
     - The cursor advances, and there are no repeated items after a restart.
3. **Linux pilot.** In Settings, turn on **Pilot: only bots selected below**, select one bot, then enable. Watch:
   - the Loose threads list (sources, ages, due flags) and Done / Next week / Leave it
   - Last review, Failures, and the review and mention-capture token counters
4. Record usefulness: accepted, dismissed and resolved loose threads, and whether the timing felt right. Then tune `RESURFACE_HOURS`, the extraction model and `packetTokens`.
5. Widen to all bots only after the pilot. Physical Mac acceptance remains deferred.

The legacy standalone bridge (`service.mjs`) has the node executor but no coordinator. `localExecutor` exists for wiring one if that path is revived.

## Tests

`bot-bridge/initiative.test.mjs` covers:
- disabled by default
- idle-only admission
- Codex ephemeral tool-free job parameters, and models (small for extraction, the bot's own for review)
- hidden job events
- refusal of tools and approvals, and invalidation on tool items
- cancellation on user activity
- stale rejection
- mention capture:
  - owner-only (peer, schedule and bot-sourced messages excluded)
  - incremental cursor and bounded batches
  - no model call when there is nothing new
  - source references
- verbatim-quote validation
- cross-bot dedup with a better-fitting responsible bot
- resolution evidence and newest-decision precedence, and that reviews cannot invent threads
- resurfacing delays, deadlines, snooze wake, priority and the reserved slot
- the loose-thread trigger and backlog order
- a proposal that quotes the original mention (“On Tuesday you mentioned to Connie…”) with its proposed action
- packet bounds and sections
- Claude extraction and review through `fakeQuery`: no session or turn, normalized usage, projection, and next-turn context
- next-turn context delivered exactly once
- the Settings list and dismiss/snooze/resolve
- triage
- delivery reconciliation and idempotency
- replies, spacing, daily limits, the 72-hour reminder, the Toronto day, and validation

## Always-on pass (October 15)

Settings version 2 (saved version 1 values equal to the old defaults follow the new ones; chosen values are kept):

- **Models:** reviews and mention capture use GPT-6 Luna (Codex) and Haiku (Claude) at medium effort, not each bot's own model. Haiku has no effort levels, so none is passed to it.
- **Input:** the last `conversationHours` (72) of high-level exchange, read with the summary view (Dawar's messages and each turn's final reply; no reasoning, tool calls or tool output), plus `MEMORY.md` and the ledger. Mention capture also reads the summary view and treats the bot's final replies as resolution evidence.
- **On change:** extraction runs only on new activity; reviews run on activity, due items, or at most every `baselineMinutes` (6 hours) as a look for new opportunities.
- **Review while busy** (`reviewWhileBusy`, default on): reviews are private and read-only, so a working bot is reviewed; delivery still waits for idle, spacing and limits. A result is stale only if Dawar wrote to the bot after the review started (`owner-spoke`); the bot's own work does not invalidate it. The node still refuses delivery if a turn starts between the delivery probe and the write.
- **Nagging:** an unanswered proposal comes back as a short reminder every `reminderHours` (12) with no model call, until Dawar answers, snoozes, dismisses or resolves it (`maxReminders` 0 = no cap). Defaults: 4 messages per bot and 20 per day, 2–4 minutes apart.
- **Hand-off:** a time-sensitive item due for `handoffHours` (12) whose bot stays unreachable moves to the most recently reviewed reachable bot; the original bot stays a contributor.
- **Claude headroom:** Claude jobs are refused (`claude-limit`) while any subscription window is at or above `claudeHeadroomPercent` (80%).
- **Repair, not discard:** a loose-thread proposal missing its action uses the required first step; a missing item ID uses the bot's only open loose thread, otherwise the decision becomes `hold` (no failure or backoff).
