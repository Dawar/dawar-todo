# DawarTodo interface system

This guide describes the shared system implemented in the application. The whole
application review remains in progress. Per-surface implementation, verification
evidence and remaining work live in the [coverage inventory](https://docs.google.com/spreadsheets/d/1K6KX58asVe5dutXqPcCLA_Bf47949QYLVFQysL1ZmV8).
This document is a working specification, not a release or device-acceptance log.

## Direction

A quiet workspace for tasks and conversations. Prioritize readable content,
stable reading position and the next useful action. Use neutral surfaces, dark
text and restrained green for primary actions and selection. Routine UI should
describe what the user can do or what happened; keep diagnostics and internal
identities in deliberate details or operational records.

Chat follows native Codex thread, turn and item identities. Presentation must not
invent execution, certainty, settings or message order.

## Foundations

`app/design-tokens.css` owns semantic colors. Shared shadcn primitives live in
`components/ui`; `lib/utils.ts` merges their utility classes. Feature CSS owns
layout and domain-specific presentation, without redefining shared controls.

| Area | Standard |
| --- | --- |
| Typography | System sans. Body 14–16px; chat 16px/1.65; supporting text 13px/1.45; section headings 18px/1.3; page headings 24px/1.25. Weights 400, 500 and 600. |
| Compact exceptions | Message times, compact counts and selected file metadata may use 12px. Required instructions and recovery actions remain readable at normal supporting-text size. |
| Spacing | 4px base. Use 4/8px within controls, 12/16px within groups, 24/32px between sections. |
| Surfaces | Paired background/foreground tokens for page, card and overlay. Thin borders group content; shadows belong to floating surfaces. |
| Controls | 36px minimum desktop height; 44px mobile hit targets. Mobile text fields use 16px to avoid automatic focus zoom. |
| Shape | 8px controls, 12px panels. Avatars and deliberate icon actions may be circular. |
| Focus | Visible 2px ring and offset. Preserve native keyboard order; restore focus to a connected opener after a dialog. |
| Motion | Brief transitions, never necessary to understand status. Respect reduced motion; stop animation while hidden or offscreen. |
| Responsive | Review 320, 390, 768 and 1280px. Keep overflow within its component and preserve useful conversation space. |

Use `primary` for the main action, `accent` for selection, `muted` for supporting
surfaces, `warning` for retained uncertainty, and `destructive` for errors or
destructive actions. Pair every fill with its foreground token. Text and icons
must communicate status without color alone.

Enabled control boundaries use `input`, distinct from decorative `border`.
The light input token `#7c8980` has at least 3.22:1 contrast against the tested
opaque background/card/muted/accent surfaces; the desktop viewer's dark input
token `#71859f` has at least 3.41:1 against its tested opaque surfaces. These
calculations do not establish contrast for every translucent or disabled state.

## Shared components

| Need | Implementation and usage |
| --- | --- |
| Actions | `Button`: primary, secondary, outline, ghost, destructive. Use explicit `type="button"` outside intentional form submission. Icon-only actions need accessible names. |
| Fields | `Input`, `Textarea`, `NativeSelect`. NativeSelect retains browser and mobile picker behavior. Use persistent labels and associated help/error text. |
| Validation | Set `aria-invalid` and connect the error with `aria-describedby`. Shared fields provide the destructive border/ring. Invalid explicit submission focuses its field or summary; background refresh does not steal focus. |
| Grouping | `Card` for coherent sections. Avoid decorative nested cards and shadows on static forms. |
| Dialogs | Radix `Dialog` and `ControlledDialog` for state-driven openings. Use `ConfirmDialog` for consequential confirmation. |
| Tables | Shared `Table` with a named, keyboard-focusable overflow region; preserve headers/captions and numeric alignment. |
| Status | `Badge` is a noninteractive label. Use a Button for actions. `Skeleton`, `ScreenLoading` and `ScreenError` provide shared loading/recovery presentation. |

Disabled controls remain legible and retain native disabled semantics. Do not
add an explanatory paragraph when the prerequisite is already clear. A feature
must expose an actionable error or meaningful unsupported state when needed.

### Dialogs and focus

Use a semantic card surface, 35% backdrop, 16px viewport gutter and bounded
dynamic viewport height. Keep long bodies internally scrollable and close
controls reachable. Titles have a readable 1.375 line height.

Radix owns containment and Escape. Controlled dialogs restore the connected
opener. For a chain such as attachment picker → voice memo or project assignment,
retain the original opener explicitly; the intermediate menu item disappears.
Nested dismissal closes the inner dialog first. Destructive confirmation focuses
Cancel initially. Outside dismissal is prevented where a private or unsaved
workflow requires it.

Bot Details uses this foundation as a full-height right drawer. Its tabs retain
local React Activity state and arrow/Home/End navigation. Task detail's existing
pull-to-close shell and the remote desktop viewer's keyboard/gesture shell are
explicit custom integrations; shared colors alone do not make their behavior
equivalent to Radix. Their full interaction coverage stays in the inventory.

## Navigation and density

Keep Tasks, Bots and Settings visually consistent. Primary labels use 13px on
mobile and 14px on larger screens. Below 360px, omit the unreadable brand text
fragment while retaining the icon, full accessible name and 44px hit area.

The bot list omits a redundant Bots heading. Bot rows expose selection/unread
status to assistive technology; named rows treat their avatar as decorative.
Keyboard movement respects virtualization and does not steal focus after the
user moves elsewhere. Team headings and their virtual offsets both use 44px.

At 480px and below, chat headers reserve space for the bot name. Less frequent
Desktop/Up next actions remain in Bot Details instead of crowding the header.
Model, reasoning, Plan and Fast share the compact configuration row. Routine
configuration guidance, Working now and the foreground result inbox are absent.
Recorded turn settings remain available on their own disclosure, with requested
and runtime-confirmed evidence distinguished; missing values remain Unknown.

The composer has a full-width writing area above its action row. Attachment,
clipboard, queue and Stop/Send retain accessible hit targets. Latest is a floating
pill on a transparent overlay, so it does not create a blank row over messages.
Show the navigation rail/gutter only when loaded marks or earlier paging exist.

## Conversation behavior

- Render native conversation items chronologically. Commentary stays inline;
  tools, searches and reasoning summaries have compact individual disclosures.
  Completed tools remain in the same timeline, with full bodies loaded lazily.
- Merge explicit earlier-work reads into that same bounded store. Preserve native
  identity, newer streamed content, owner/thread scope and reading anchors.
- A durable local blast is visible before server acknowledgment, then reconciles
  to the receipt-backed countdown using its original identity. Keep progress
  visible and respect reduced motion. An unconfirmed result is never success.
- Show Sending or Queueing while the corresponding request is in flight. Reserve
  recovery warnings for a failed or unconfirmed result after the request settles;
  an older status-read error must not replace a newer delivery event. Keep the
  original message and action identity available throughout recovery.
- Private-form metadata updates through events and bounded reconciliation on
  mount, reconnect, foreground return or explicit Retry. There is no recurring
  form poll or routine Checking indicator. Forms open on explicit user action.
- Scheduled findings, application receipts and private forms retain their own
  provenance; they are not silently represented as ordinary model messages.

### Freshness and perceived latency

Start one bounded current-history read as soon as authenticated transport is
ready. Cache hydration and legacy import run alongside it. A slow cache must not
delay completed output; a late cache read must not replace newer content or
explicit reading intent. Restore a saved anchor once if the reader has not moved.

Every hidden-to-visible return triggers a fresh check. Duplicate focus/pageshow
events coalesce within 500ms; a ten-second cooldown must not suppress a quick
return. Hidden, offline, disposed and foreign-owner views issue no new reads.

Foreground recovery bypasses background connection backoff. A bounded three-second
liveness probe detects a half-open socket. Dead read requests release their
callers; mutation uncertainty stays under the original durable recovery rules.
Full snapshot requests coalesce. Push-subscription lookup has a 150ms startup
budget and cannot block session connection. These are event-driven paths.

Measure reopen/reconnect catch-up and response-to-render separately from model
execution. Controlled cache/network fixtures establish ordering and bounds;
physical phone/PWA suspension and network behavior require separate evidence.

### PWA updates

On open or foreground return, compare the page with the same-origin published
build manifest and the active worker. Coalesce checks; skip hidden/offline pages;
bound manifest reads to five seconds and 4KiB. A failed check does not mean current.
Discovery is independent of conversation connection and uses no recurring timer.

Show one compact offer when a different build is known. Refresh when ready uses
the existing draft/storage/asset/call guards. Later dismisses only that version.
Never force reload, clear site storage or discard drafts to adopt an update.
Notices float above full-screen views within safe-area bounds, including Bots.

## Task flows

Task views keep Open, Snoozed, Done and All visible at 320px. Controls and bulk
actions wrap or scroll within their own row. Task titles resize with content and
available width; one shared width observer batches title measurement rather than
adding a resize loop per row. Editing projects only the affected task.

Use semantic badges for priority, due/snooze, recurrence, offline and queued
status. Keep notes and attachments below readable titles. Mobile swipe actions
pair their foreground/background colors; gesture behavior stays in the existing
task controller.

Task details use labeled fields, Markdown description preview, visible autosave
status and reachable quick actions. `TaskSaveStatus` distinguishes Saved, Saving,
Saved on this device and errors with text/icons. Preserve invalid or rejected
input and provide recovery. Offline operations, Undo and reconnect retain their
original records rather than creating replacement task identities.

Task notifications use the contrasting dark toast surface, a concise outcome,
optional task preview and separate Undo/snooze actions. They sit above the bulk
bar and safe area. Keep errors distinct; announce success as status and errors
as alerts. Do not let a toast cover the controls needed to recover.

Saved-change recovery presents labeled values instead of raw JSON, with bounded
details for long or unknown fields. File recovery separates storage-read errors
from action errors; a successful read clears only its own stale error.

### Queue lists

Keep read recovery separate from action delivery. A failed refresh offers a short
Retry action and retains any cached messages; it must not expose raw transport
errors or imply an unread queue is empty. The request generation starts before
all dependent reads, and late results from a previous selection are ignored.

List editors retain values after rejection, show neutral Saving feedback while
an original action is pending, and associate each invalid schedule field with
its own error. Manual lists omit scheduling fields. A confirmed empty queue has
one concise empty state; loading and offline states remain distinct.

Scheduled work shows the next time in its configured timezone. A past one-time
schedule is labeled as passed, never completed without execution evidence. Delete
uses the shared destructive confirmation, initially focuses Cancel, and becomes
unavailable if connection or action state no longer permits the change.

## Files, media and structured content

Galleries preserve cached content during refresh failure and distinguish updating,
offline and refresh unavailable. Use bounded cursor paging, scoped lazy previews,
wrapping names and readable metadata. Keep original file access explicit.

File viewers retain fixed header/footer actions and an independently scrollable
body. Markdown tables/code have named keyboard-focusable overflow regions. HTML
remains sanitized and sandboxed; visual adapters consume data, not executable
scripts. PDF pages intentionally retain a white paper background.

Pending attachments distinguish Ready to attach, Saved on this device, Uploading
and failed states. Only eligible failures offer Retry; existing ownership, byte
retention and same-operation recovery remain in the controller. Private input
does not enter ordinary file/history flows, and model-read consent stays explicit.

Voice memo presentation uses shared controls without changing MediaRecorder
ownership or attachment limits. A recording/review fixture is separate from
genuine microphone, playback, upload and device acceptance.

## Settings, rooms and operational views

Settings sections use shared fields/cards with 13px supporting text. Tokens,
calendar links and phone controls retain their exact confirmation consequences.
Sign-out preserves local drafts. Long access names wrap; raw diagnostic payloads
do not appear in ordinary settings.

Calendar links and task-request origin checks use the configured public HTTPS
origin, never an untrusted forwarded header or loopback site address. Identity,
CSRF, guest grants, API tokens and node credentials remain separate controls.

Usage identifies the bot whose assigned machine supplies the account. Every read
carries that bot identity; quota belongs to the account, not the bot. Preserve the
selected source through snapshot reordering, fence late owner/placement reads,
and make no unscoped request when no source is eligible. Charts/table overflow
stays local to the dialog; unavailable quota is neutral, exhausted destructive.

Room conversations retain canonical scoped history, drafts and addressed
recipients. Recipients/message kind use a compact disclosure; paging controls
respect reading anchors. Empty/search/error states are explicit. Goal, queue,
schedule, team, approval and earlier-work controls retain their distinct native
authority and uncertainty rather than collapsing them into one generic status.

The desktop viewer has a scoped dark semantic palette; fields and selected keys
use matching foreground pairs. Preserve its input, IME, lease and gesture rules.
Operator distinguishes failure to connect from a connected call that ended.
Neither a rendered fixture nor a source build proves a real call or remote input.

Avatars share one animation frame loop. Reduced motion retains a static expression;
hidden/offscreen/paused avatars unsubscribe. Disposal removes media/visibility
listeners and observers. Invalid rendering retains accessible initials. Appearance
settings persistence is reviewed separately from renderer lifecycle.

## Verification and completion

The inventory uses Not started, In progress, Implemented, Verified and Blocked.
Verified requires exact source plus relevant rendered sizes, state/keyboard/focus
and regression evidence. A controller or declaration with no independent UI is
verified at its own boundary; consumer flows retain their own rows. Record actual
unavailable-device or environment limits without treating unreviewed work as blocked.

Use existing relevant checks and disposable fixtures for effectful workflows.
Keep source-ready, merged, published, installed and genuine user/device acceptance
distinct. Preserve owner data, drafts, native history, Stop, Goals and uncertain
operation identities throughout design changes.

The overarching Goal stays open until every inventory item is verified or has a
concrete blocker, the guide agrees with the application, and known inconsistencies
are tracked. Full flow/state review and genuine phone/PWA catch-up acceptance
remain unfinished. Do not replace those gates with a build result or a stale count
copied into this document.

Upstream provenance: [shadcn manual installation](https://ui.shadcn.com/docs/installation/manual)
and the [new-york Button registry](https://ui.shadcn.com/r/styles/new-york/button.json),
retrieved October 11, 2026. Local accessibility, mobile sizing and domain behavior
are maintained in this repository.

Schedule editing preserves the existing paused/enabled state. Date/time drafts stay
visible while editing the timezone or switching recurrence. Invalid timezone, cron
and daylight-saving inputs use associated field errors; pending saves disable fields
and repeated submission. Offline editing retains the draft with Save unavailable.
A bot/owner change dismisses the old editor. Shared Radix dialogs own focus and
Escape handling; consumers must not add a second document-level focus trap.


### Goal progress and native work plans

The Goals panel shows up to five already loaded native conversation work plans,
oldest to newest, with the most recent expanded. Reuse the chat's native step
renderer, disclosure controls and bounded pagination. Plans must match the exact
thread and have a known turn start at or after the Goal's creation. Unknown or
older provenance is omitted. The panel subscribes to the existing conversation
store; it adds no polling, history scan or model turn. Offline plans are labeled.

A native plan belongs to a turn, not a Goal. Preserve its recorded step statuses;
label finished, failed and interrupted turns and keep native Goal completion
separate. Never derive overall completion percentages from tokens, time, loaded
plans or inventory counts. Missing plans get a concise empty state rather than
an invented checklist. Native Goal controls and their scope checks are unchanged.


Queue action status names the original operation (sending, moving, reordering,
removing, saving or queueing). Keep uncertain receipts and deliberate recovery
visible; unreadable local receipts offer a read-only retry. An acknowledged
list save/delete must only close the editor or change the selection it started
from. A delayed follow-up read never overrides a newer draft or navigation.
Invalid stored schedule dates/timezones display a fallback instead of breaking
the queue screen.

Queue lists and their embedded messages share one action controller and one status region. A successful local-receipt recovery clears the entire view; nested panels must not retain a second stale warning or accept a competing action.

Queue drag and keyboard reordering use the same allowed moves. A queue revision, connection, list, or action-state change cancels an in-progress drag. An older completed request cannot clear a newer pending order; owner/bot/list changes start with fresh local selection and gesture state.

## Current review scope

Dawar excluded Discussions and bot-to-bot messaging UI from this design goal on October 12, 2026, for a separate rebuild. Collaboration rooms, peer-message history, discussion controls and their dedicated UI controllers are not completion requirements. Prior evidence is retained as excluded reference material. Foreground human-to-bot chat, sending, bursts, queues, bot navigation, settings, Goals and PWA sync remain in scope. Shared files are reviewed for those retained surfaces only.
