# shadcn AI Elements adoption and Conversation Chapters

Work: `cody-shadcn-ai-elements-ui-20261014-v1` (amended) and
`cody-conversation-chapters-sidebar-20261014-v1`. First pass base `codex/bots`
9f2331b; second pass (remaining patterns) base `codex/bots` 3d0277a.
Components are copied/adapted locally under `components/ai-elements/`
(Radix-compatible, no new dependencies, no AI SDK transport). They are fed by
existing Codex native/bridge/history contracts.

## Pattern inventory (all 21)

Second pass (base `codex/bots` 3d0277a) finished every pattern with real
evidence. Display adapters live in `lib/ai-elements.ts` (pure, tested in
`tests/ai-elements.test.mjs`); components in `components/ai-elements/`. Claude
bots feed the same item shapes through `bot-bridge/claude-items.mjs`.

| Pattern | Status | Source / reason |
| --- | --- | --- |
| Tool | Implemented | `toolView()` reads `mcpToolCall`/`dynamicToolCall` only: **Parameters** (the native `arguments`, already in the raw JSON before), **Result** (text content / structured content), **Error** (`error.message`, or failed dynamic output), non-text results counted, never shown. Row summary adds the producer's `durationMs`. Other items keep the raw Code Block fallback. |
| Task | Implemented (via Trace) | Native work rows (`bots-native-work`) share the Trace icon/state vocabulary; steps are observed native items with original turn/item IDs. |
| Plan | Implemented | Native Work plan (`WorkPlanMessage`) gains `PlanProgress` (completed/total from the native steps; partial plans use the native `totalSteps`) and per-step `PlanStepStatus` (completed/in progress/pending — unknown status stays pending). Final proposed plan keeps `ProposedPlanText`, now with a Plan icon; the two stay distinct. |
| Reasoning | Implemented | Visible `reasoning` summaries only, behind the existing disclosure with the Trace reasoning icon; the duplicate inner "Thinking" label inside work rows is removed. `content` is still stripped by the controller. |
| Chain of Thought | Existing/reused | Same visible summaries; private reasoning is never exposed and no step chain is synthesized. |
| Terminal | Implemented | `commandExecution`: terminal Code Block with ANSI escapes stripped for display (`stripAnsi`), Copy returns the exact raw output; footer = Trace status + exit code (missing → "Exit code unknown", never success) + `durationMs` + `cwd`. No process controls. |
| Stack Trace | Implemented (display) | For a finished command with a non-zero/unknown exit, `parseStackTrace()` reads JS (`at fn (file:line:col)`) or Python (`File "…", line N, in f`) frames from the exact output; ≥2 frames of one shape required, 40-frame bound, last 64 KB only. Library frames (`node:`, `node_modules`, site-packages) fold into a disclosure. Raw output remains above; nothing is opened or fetched from a frame. |
| Test Results | Unsupported (safe fallback) | No structured test-result producer; pass/fail is never inferred from text. Output stays in Terminal. |
| File Tree | Unsupported (safe fallback) | `fileChange` lists paths with per-file diff Code Blocks; no tree is fabricated. |
| Message | Implemented (consistency) | `BotMessage` bubbles, sender badges, three-line bot disclosure and quote/copy routes unchanged; final answers gain Sources; footer actions (Reply, Pin as Chapter, time) unchanged. |
| Chat | Existing/reused | Chronological feed and `use-feed-scroll.ts` retained. Message Scroller still not adopted: bounded window/prepend anchors/read-position/Latest have no equivalent in the primitive (`tests/bot-scroll-latest-browser.mjs` remains the gate). |
| Marker (supporting) | Implemented | Native `contextCompaction` items (not the deferred "Work log" entries that reuse that type) render as an inline `Marker` divider instead of an expandable empty row; same `data-history-key`, so anchors/chapters still resolve. |
| Prompt Input | Implemented (polish) | Composer controller, Enter/Send, Ctrl+Enter Queue, Stop, blast Send now/Edit, copy/paste composer untouched. The settings row now carries the Context meter; no new submit path. |
| Model Selector | Implemented (polish) | Same `NativeSelect` + controller (`edit()` only). Model/effort controls state they apply to future turns and that a running turn keeps its settings; the existing "Next turn" save status remains the confirmation evidence. No restart/steer. |
| Attachment (supporting) | Implemented (polish) | Composer chips show a type icon (`attachmentKind`) and size (`formatBytes`) from the staged file metadata; open/remove/review/upload status routes unchanged. |
| Suggestion | Implemented | Codex follow-up shortcodes render as Suggestion chips (`ai-suggestion`) but still only call `prefillText` for review; a non-empty draft still asks Append/Replace; disabled while a genuine question is pending (verified in the browser check). |
| Sources | Implemented | `messageSources()` lists the http(s) links already written in a completed final answer (deduped, max 20, no credentials, no `bot-*`/file schemes) in a collapsed "Used N sources" disclosure. Nothing is fetched or previewed. File citations keep `file-citation.tsx`. |
| Inline Citation | Implemented | A link whose visible text is a reference number (`1`, `[1]`) or its own URL renders as a citation pill (index + host, full URL in title). Other links stay ordinary links; registered file citations keep their policy. |
| Confirmation | Implemented | Genuine approval requests (`*requestApproval`, legacy approvals) get an "Approval needed" heading with icon; the command renders in a Code Block. Same decisions, keys and `respond` route; no new approval step. |
| Questionnaire (supporting) | Implemented | `item/tool/requestUserInput` cards show the question count and each question's native `header` chip. Options, free text, secret fields, Task Request entry and answer recovery are unchanged. |
| Context | Implemented | `contextMeter()` uses `bot.contextCompaction.context` (native `tokenUsage.last` tokens + `modelContextWindow`, produced for Codex and Claude bots). Hidden when the window is unknown/zero — no guessed percentage. Ring + % in the settings row; clicking only opens Bot details → Settings (existing compaction controls). Compacted-since-measurement is dimmed and announced. |
| Queue | Existing/reused | Human Up next/queue lists remain the only queue UI; there is no agent task-queue producer distinct from them. |
| Checkpoint | Unsupported | No authorized rollback/resume route exists; none was added. |
| Subagent | Implemented (verified provenance only) | `subagentView()` accepts native `subAgentActivity` (agent thread id, path, kind, model/effort) and `collabAgentToolCall` with receiver thread ids (+ per-agent native state/message, the sent prompt in a disclosure). Rows are labelled "Subagent". Claude `Task` calls and items without agent thread identity keep the ordinary Tool row. Display only: no controls, no revived Discussions. |

Supporting primitives: **Trace** (`components/ai-elements/trace.tsx`),
**Code Block** (`components/ai-elements/code-block.tsx`, used for fenced code,
diffs, terminal output, tool parameters/results and approval commands;
Mermaid keeps its renderer). Second pass adds **Tool**, **Stack Trace**,
**Plan**, **Sources/Inline Citation**, **Context**, **Marker** and
**Subagent** (`components/ai-elements/*.tsx`); Questionnaire/Attachment are
presentation changes on the existing routes.

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

## Checks (second pass)

- `tests/ai-elements.test.mjs` (9): adapters, bounds, null-on-missing-evidence,
  static render of each component, and source guards (no rpc/fetch/send in
  display code; Suggestion only prefills; meter only navigates).
- `tests/ai-elements-browser.mjs [dir]`: real workspace + Chromium over the
  synthetic transport (`?elements` fixture) at 1440 docked, 390 and 320:
  asserts every pattern renders from native shapes, no horizontal overflow,
  expand/collapse of all activity rows sends nothing, Suggestion is disabled
  while a question is pending and then prefills the draft without sending.
  Writes `elements-*` screenshots.
- `tests/bot-chapters-browser.mjs` also writes `elements-desktop-1440` and
  `elements-mobile-390` (note: expanded detail bodies stay "Loading…" there
  because `--virtual-time-budget` stalls the IndexedDB detail read; use the
  CDP-driven check above for expanded rows).
- `tests/bot-scroll-latest-browser.mjs` unchanged and passing.

Rollback: revert the second-pass commit; no data, route or dependency changes.

## Checks (first pass)

`npx tsc --noEmit`, scoped eslint, `npm run build`, `tests/bot-chapters.test.mjs`
(7 tests). `tests/bot-chapters-browser.mjs <dir>` renders the real workspace
with a synthetic transport for 1440/1024 docked, 800 drawer and 390/320 mobile
screenshots. Physical device/PWA and installed sync acceptance remain separate.

Rollback: revert the two commits; the `bot-chapters:v1:*` app_settings rows are
inert without the route.
