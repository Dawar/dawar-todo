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
| Writers' room: panel, roles, stages, anonymization, citations, judge, scoring, A/B arms, budget | `bot-bridge/initiative-room.mjs` | hub (steps run as private jobs on each member's node) |
| Settings UI | `app/bots/initiative-settings.tsx` (`initiative.read`, `initiative.configure`, `initiative.thread`) | site |
| Owner outcomes | `bots_initiative` tool, first-reply classification in `HubControls.nativeEvent`, and Settings actions | node → hub, site → hub |

Records:
- **Hub:**
  - `initiativeItem`: the kind `loose-thread` adds `category`, `entity`, `importance`, `mentions[]`, `lastTouchedAt`, `resurfaceAt` and `resolution`.
  - `initiativeBot`: adds `mentionCursor` and `lastExtractionAt`.
  - `initiativeReview`: the field `kind` is `extract` or `review`.
  - `initiativePublication`: adds `proposalId` and `roomId`.
  - `initiativeProposal`: a stable id. Its `content` never carries authorship; `authorship {botId, reviewId|roomId, provider}` and `credits [{botId, share}]` sit beside it.
  - `initiativeContribution`: one per bot, with points, counts per kind and the last 60 events.
  - `initiativeRoom`: one per room round.
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

## Writers' room (phase 2)

Dawar's principle: competition during discovery, cooperation after selection. Agents are fiercely ambitious about the quality of their own ideas and unselfish about which idea wins. The room is off by default (`room.enabled: false`).

### When a room runs

- **Agenda.** The triage step for the room picks the single most valuable due loose thread with priority ≥ `room.minPriority` (4.5: a high-importance client or commitment as soon as it is due; a high-importance person or company after a few hours overdue; ideas and medium items stay with ordinary reviews). The thread must also be outside its `cooldownHours` (72). Only one room runs at a time.
- **Ordinary review.** The responsible bot's ordinary review waits while the room works the item. A solo proposal for an item with an active room is blocked (`room-active`).
- **Budget.** Before starting, the room estimates its cost as `(packet + 2.5k) × (members × (1 + 2 × critique rounds) + 1)`. It is skipped (`skipped: budget`) if that would exceed `room.dailyTokens` (400k) today. Settings shows the budget used.
- **Limits.** Delivery limits are unchanged: one room produces at most one ordinary publication within the 2-per-bot and 5-per-day limits. The point is fewer, better messages.

### Panel and roles

- **Panel.** `room.panelSize` (3) members. The responsible bot is always in it; the rest are the best contributors by record. Providers are mixed: a missing provider's best bot is taken first.
- **Roles from history.** Each member's strongest contribution category decides its role:
  - selected or approved → proposer
  - improved → refiner
  - confirmed flaws → critic
- **The delivering bot** is the executor.
- **Styles.**
  - At most one proposer is contrarian.
  - Critics are flaw-finders.
  - Refiners and the executor are practical.
  - A panel of three or more always has a critic.

### Steps

Each step is an ordinary private job (`kind: "room"`) on the member's own node, provider and model. It is tool-free, hidden and bounded exactly like a review. A member that is not idle simply sits that step out.

1. **Shared packet.** The packet is built once on the responsible bot's node (`initiative.node.packet`). It has no identity, memory or bot names, and mention refs are neutral (`mention:<turn>:<item>`). Every line a claim can rest on carries a ref:
   - `msg:<item>` and `turn:<id>`
   - `mention:…` and `item:<id>`
   - `schedule:`, `queue:` and `artifact:`

   Each member adds **its own** role and memory (≤ 8k characters) on its node.
2. **Blind drafts.** All members draft in parallel. A draft prompt contains no other member's work, and `proposal: null` (nothing worth raising) is allowed.
3. **Anonymization.** The hub strips bot names, slugs and ids, provider and model words (Codex, Claude, GPT…, Opus…), “as an AI…” phrases, emoji, Markdown emphasis and sign-offs. Versions get neutral labels A, B, C… in an order that does not follow the panel. Authorship lives only in `room.authors`.
4. **Critique.** Each member critiques the versions it did not write. Authors are shown only when an experiment arm turns anonymity off, and never to the judge. Every critique must cite packet refs:
   - An uncited critique is discarded.
   - A citation that does not match the packet makes the critique **misrepresentation**: it is discarded and penalized.
5. **Improve.** Any member may submit improved versions (at most 2) of any version, including competitors', naming the critique ids it addresses. Steps 4–5 repeat `critiqueRounds` (1) times.
6. **Blind judge.** A separate call on the responsible bot's node (`room.judgeModel`, or that bot's model) sees only the packet, the anonymous final versions under fresh labels (P1, P2…, no base, stage or author) and the anonymized critiques.
   - It scores each version 0–5 on value, time-sensitivity, evidence, actionability and effort.
   - It selects one version or **nothing**.
   - The hub weights the scores (`room.weights`). The winner is the top weighted version, provided the judge selected something and the score is ≥ `minScore` (2.5).
7. **Shared execution.** The responsible bot delivers the winner as an ordinary publication: the quote header, the proposal, then “_From the room…_”. The other panel bots become contributors to the ledger item and record help with `bots_initiative operation=contribute` after approval.

### Contribution record (per bot)

| Event | Points |
|---|---|
| proposal selected (as author; the base author of a winning improvement gets half) | +5 |
| improved another's proposal and the judge scored the improvement above its base | +4 |
| genuine flaw: a critique confirmed by the judge or addressed by a better-scoring improvement | +3 |
| helped execute an approved item (`contribute`, once per item) | +3 |
| re-pitched its own losing idea from an earlier room without new evidence | −2 |
| misrepresentation: citations that are not in the packet (per draft, critique or improvement) | −6 |
| **Dawar's outcome** on the delivered proposal, for the credited bots × share: approved / done / dismissed | +6 / +8 / −6 |

Dawar's outcomes weigh most. A judged win he dismisses (+5 − 6) ends below a judged win he never saw, so the room optimizes for him, not for the judge. The record chooses panels (by points) and roles (by category) in later rounds.

### Experiments

- **Arms.** `room.experiment = {enabled, arms: [{name, panelSize?, anonymity?, critiqueRounds?, weights?}]}`, with at most 4 arms. An item is assigned to an arm by a stable hash of its id. With no experiment, every room is the `control` arm.
- **Comparison.** Settings shows, per arm:
  - rooms, sent and nothing
  - approval rate: approved or done ÷ sent
  - completion rate: done ÷ sent
  - tokens per useful (approved or done) proposal

### Cost per room round

These numbers come from production message sizes over Oct 8–14:
- owner messages: median 87 characters, p90 481
- final answers: median 271 characters, p90 1,098
- profile, user and memory files: median 6.1 KB combined, p90 34 KB

The shared packet holds at most 24 recent turns plus the agenda item and has no identity or memory. That makes it about **3.5k tokens at the median** and about **10k at p90** (the cap of 12k is rarely reached).

| Default round (3 members, 1 critique round = 10 calls) | Median packet | p90 packet |
|---|---|---|
| Drafts: 3 × (packet + instructions + own profile 1.4–2k) | ≈ 16k | ≈ 38k |
| Critiques: 3 × (packet + 2 versions) | ≈ 18k | ≈ 40k |
| Improvements: 3 × (packet + all versions + critiques) | ≈ 20k | ≈ 42k |
| Judge: packet + 4–5 versions + critiques | ≈ 6k | ≈ 12k |
| Output (≈ 400 + 250 + 450 per member, plus judge) | ≈ 4k | ≈ 4k |
| **Total per room** | **≈ 65k tokens** | **≈ 135k tokens** |

- A room costs about 9–10 solo reviews (≈ 7k each).
- The default budget of 400k/day allows about 3–6 rooms.
- A 2-member, 0-round arm (5 calls) costs about a third.
- The shared packet comes right after the fixed instructions, so steps on the same provider within minutes can reuse its prompt cache. These estimates assume no caching.

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

Room acceptance before enabling it, after the loose-thread pilot:
- One manual room on a high-value thread with a mixed Codex/Claude panel. Check:
  - the judge input in the private job record has no names
  - critiques cite real refs
  - the delivered message reads well
  - `room.tokens` is close to the estimate
- Then enable an experiment with two arms (for example anonymity on/off) and compare the arms in Settings after a few weeks.

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
- stable proposal ids with authorship kept apart from content, outcome credits and execution credit

`bot-bridge/initiative-room.test.mjs` covers:
- a mixed Codex/Claude room end to end:
  - blind drafts (no cross-visibility)
  - anonymization (no author, provider or style tells in versions, and nothing in the judge input)
  - an uncited critique discarded and mismatched citations penalized
  - improvement attribution
  - the judge picking the improved version
  - credits: selected, half-share, improved, flaw and misrepresentation
  - delivery from the room by the responsible bot with panel contributors
  - Dawar's approval weighting
  - execution credit
  - arm metrics
- the judge selecting nothing (no message, no selection credit)
- anonymization and citation helpers, weighted scores, and authors shown to critics only with anonymity off and never to the judge
- role assignment from history
- re-pitch and misrepresentation penalties, and a dismissed win scoring lower
- stable A/B arm assignment and per-arm approval, completion and cost
- off by default, high-value items only, the token budget, and unchanged delivery limits
