# Proactive bots: the inner monologue

Every bot thinks on its own, privately and in isolation, and messages Dawar
when it has something worth his attention. This replaced the earlier
review/ledger system (loose-thread extraction across bots, a shared ledger,
cross-bot routing and hand-offs, template reminders), which made bots raise
things from each other's conversations and nag on a timer.

## The loop: think, then maybe speak

- **When.** Each bot has its own `nextThinkAt`. The default rhythm is about
  hourly, every 30 minutes within 3 hours of a conversation, and every 3 hours
  during quiet hours. Each wait is jittered by ±25%. A thought can ask for its
  own next time (15 minutes to a day). Dawar writing to a bot resets it to the
  after-conversation rhythm. Thinking happens even when nothing changed: time
  passing is new information.
- **What it reads.** Only its own world:
  - IDENTITY/SOUL/USER and the newest end of MEMORY.md;
  - the last 72 hours of its own conversation (summary view: messages and
    final answers only);
  - the messages it sent on its own;
  - its last 15 journal entries and its open loops;
  - its own schedules;
  - Dawar's priorities;
  - the local day and time, and how long since Dawar last wrote.

  Nothing from other bots.
- **What it writes** (`THINK_SCHEMA` in `mind.mjs`):
  - a first-person thought, kept in the journal;
  - its updated list of open loops (`open`, `raised`, `done`, `dropped`; ids
    are reused, and closed loops are remembered for a week);
  - `quiet` or `speak` with a message;
  - optionally, when to think next.
- **Models.** Thinking uses a light model: `gpt-6-luna` for Codex bots,
  `haiku` for Claude bots, at medium effort. When a bot decides to speak and
  `speakWithBotModel` is on, a second private job with the bot's own model
  rewrites the message in its voice. If that fails, the thought's draft goes
  out instead.
- **Follow-ups come from judgement.** The bot sees what it raised and when.
  Whether to follow up, and how, is its own decision in its own words; there
  are no template nudges and no reply codes.

## Delivery

One outbox (`initiativePublication` with `mind: true`), delivered as the bot's
ordinary chat message by projection (no native write, no model turn), with a
push titled with the bot's name. The rules:

- no delivery during quiet hours (default 21:00–08:00 America/Toronto);
  messages decided overnight wait for the morning;
- a random 5–20 minutes between any two messages, across all bots;
- caps of 4 per bot and 20 in total per local day;
- only to an idle bot (thinking may happen while it works);
- dropped if Dawar writes to that bot first (the bot thinks again in 5
  minutes, with his message in view), or after 12 hours;
- `messagesEnabled: false` pauses sending entirely: bots keep thinking and the
  journal shows what they would have said. Upgrading from the review system
  starts paused, as a test run.

The next real turn tells the bot what it said on its own (`proposalContext`),
once. The bot's `bots_initiative` tool reads its own thoughts and loops, and
notes what was settled in conversation.

## Where things live

- `mind.mjs` holds the settings (meta `initiative-settings`, version 3), the
  prompts, the schemas and validation, loops, cadence and quiet hours.
- `initiative-coordinator.mjs` runs on the hub: scheduling, journal
  (`mindEntry`), state (`initiativeBot`), jobs (`initiativeReview`, kind
  `think` or `speak`), the outbox, status and the tool.
- `initiative-node.mjs` runs on the node: tool-free, read-only private jobs
  (an ephemeral Codex thread or a standalone Claude query), probe, publish
  and reconcile.
- `initiative-packet.mjs` assembles what a thought reads on the node.
- The UI has two parts:
  - the **Proactive bots** page: mode, priorities, rhythm, messages and quiet
    hours, and every bot's latest thought;
  - each bot's **Mind** panel: its switch, Think now, its loops and its
    journal.
