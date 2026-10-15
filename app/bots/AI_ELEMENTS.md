# shadcn AI Elements adoption and Conversation Chapters

Work: `cody-shadcn-ai-elements-ui-20261014-v1` (amended) and
`cody-conversation-chapters-sidebar-20261014-v1`. Base `codex/bots` 9f2331b.
Components are copied/adapted locally under `components/ai-elements/`
(Radix-compatible, no new dependencies, no AI SDK transport). They are fed by
existing Codex native/bridge/history contracts.

## Pattern inventory (all 21)

| Pattern | Status | Source / reason |
| --- | --- | --- |
| Tool | Implemented | `message.tsx` tool rows use `TraceIcon` + `TraceStatus` from `lib/trace-state.ts`; status from the native item's own status/exit code/success only. Bodies render through Code Block. |
| Task | Implemented (via Trace) | Native work rows in `timeline.tsx` (`bots-native-work`) share the same icon/state vocabulary; steps are observed native items with original turn/item IDs. |
| Terminal | Implemented | `commandExecution` output renders as a terminal-variant Code Block (exact text, paged by `TextPages`, exit code footer; missing exit code is never shown as success). No process controls added. |
| Chain of Thought | Existing/reused | Visible `reasoning` summaries keep the existing "Thinking" disclosure. Private reasoning is never exposed; no new data. |
| Reasoning | Existing/reused | Same as above; summaries only. |
| Plan | Existing/reused | Native Work plan (`WorkPlanMessage`) stays distinct from final Proposed plan (`ProposedPlanText`). Work-plan rows now carry the Trace icon/progress. |
| Message | Existing/reused | `BotMessage` bubbles, sender badges, three-line bot disclosure and quote/copy routes unchanged. |
| Chat | Existing/reused | Current chronological feed and scroll controller retained. Message Scroller not adopted: the bounded window/prepend anchors/read-position/Latest contracts in `use-feed-scroll.ts` have no equivalent in the primitive; adopting it would need the full long-history regression set first. |
| Prompt Input | Existing/reused | Composer controller, Enter/Send, Queue, Stop and blast Send now/Edit untouched (owned by the concurrent Stop/sender-badge work). |
| Model Selector | Existing/reused | Current/next settings selector unchanged; no restyle that could imply a confirmed change. |
| Suggestion | Existing/reused | Codex follow-up shortcodes already fill the composer for review (`codex-followup.tsx`). |
| Sources | Existing/reused | Registered file citations/artifacts (`file-citation.tsx`, `returned-artifact.tsx`). |
| Inline Citation | Existing/reused | Same registered citation policy; no blanket path fetch. |
| Confirmation | Existing/reused | Genuine native questions/approvals (`run-questions.tsx`, `request-card.tsx`); no invented approval step. |
| Context | Unsupported | No supported producer supplies a known context bound to the UI; a percentage would be guessed. |
| Queue | Existing/reused | Human Up next/queue lists remain the only queue UI; there is no agent task-queue producer distinct from them. |
| Checkpoint | Unsupported | No authorized rollback/resume route exists; none was added. |
| Subagent | Unsupported | `collabAgentToolCall` rows show as Trace tool rows with their native label; no verified subagent provenance contract exists. |
| Stack Trace | Unsupported (safe fallback) | No structured stack-trace producer; raw output stays in Terminal/Code Block. |
| Test Results | Unsupported (safe fallback) | No structured test-result producer; pass/fail is never inferred from text. |
| File Tree | Unsupported (safe fallback) | `fileChange` lists paths with per-file diff Code Blocks; no tree is fabricated. |

Supporting primitives: **Trace** (`components/ai-elements/trace.tsx`),
**Code Block** (`components/ai-elements/code-block.tsx`, used for fenced code,
diffs, terminal output and raw tool JSON; Mermaid keeps its renderer).
Questionnaire/Attachment: existing routes reused, unchanged.

## Chapters and docked details

- `BotDetailsPanel` is one tree for both layouts: docked column at
  `min-width: 1000px` (no backdrop/focus trap, owner-scoped remembered open
  state in localStorage) and a modal drawer otherwise (Escape, Tab cycle,
  focus return to the details toggle). Generic opening defaults to
  **Navigation**; Goals/Queues/History/Calls/Up next shortcuts keep targets.
- The human-message tick rail (`message-tick-rail.*`, `human-message-ticks.ts`)
  is removed. Ordinary scrollbar, anchors and Latest are unchanged.
- **Pin as Chapter** appears only on completed final native assistant answers
  in the current thread (`chapterEligible`). Live/final aliases resolve through
  `timeline.resolveKey`, so repeated or replacement pins stay one chapter.
- Jumps: loaded → `feed.jumpTo`; older → one bounded `replies.prepare` read per
  click (visible continuation) then the existing quote resolver. A stale
  bookmark is reported unavailable, never rebound. No send/queue/native turn.
- Persistence: `/api/bots/chapters` (GET list, PATCH pin/rename/unpin) in the
  existing `app_settings` table under an owner-hashed, conversation-hashed key
  namespace; rows hold identity, bounded title, response time and pin time
  only. Unconfirmed changes stay on the device, labelled, and replay in order.
  Portable hubs without this route keep chapters on the device (labelled).

## Checks

`npx tsc --noEmit`, scoped eslint, `npm run build`, `tests/bot-chapters.test.mjs`
(7 tests). `tests/bot-chapters-browser.mjs <dir>` renders the real workspace
with a synthetic transport for 1440/1024 docked, 800 drawer and 390/320 mobile
screenshots. Physical device/PWA and installed sync acceptance remain separate.

Rollback: revert the two commits; the `bot-chapters:v1:*` app_settings rows are
inert without the route.
