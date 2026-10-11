# DawarTodo interface system

Status: implementation in progress. This document records the target and the
migration ledger; it does not claim that existing pages already comply.

## Direction

A quiet workspace for tasks and conversations. Use neutral surfaces, dark readable
text, and restrained green for primary actions and selected navigation. Content
and the next meaningful action take precedence over implementation diagnostics.
Chat should feel like a native Codex conversation: readable text, compact controls,
progress that expands on demand, and stable reading position.

## Foundation contract

Use shadcn components owned in `components/ui`, with semantic CSS variables and
Tailwind utilities. Keep data controllers, durable drafts, operation identities,
native state and authorization outside presentation primitives.

| Area | Standard |
| --- | --- |
| Type | System sans; body 14–16px; chat 16px/1.65; secondary text 13px/1.45; section 18px/1.3; page 24px/1.25. Weight 400 body, 500 controls, 600 headings. |
| Spacing | 4px base; 4/8px within controls, 12/16px between related items, 24/32px between sections. |
| Surfaces | Page, card and overlay use semantic background/foreground pairs. Thin borders define grouping; shadows are reserved for floating surfaces. |
| Actions | Primary, secondary, outline, ghost and destructive variants; one primary action per decision area. Icon-only controls require accessible names. |
| Sizing | Controls at least 36px high on desktop; touch targets at least 44px or equivalent unobstructed hit area. Inputs use 16px text on mobile. |
| Shape | Consistent 8px controls and 12px panels; circles only for avatars and deliberately circular icon actions. |
| Focus | Visible 2px focus ring with offset. Never remove focus without replacement. Keyboard order follows visual order. |
| Motion | Brief opacity/position transitions only; respect reduced motion; no motion required to understand status. |
| Density | Task lists can be compact. Forms and dialogs retain clear labels and sufficient separation. Avoid oversized headings inside small panels. |
| Responsive | Audit 320, 390, 768 and 1280px. Dialogs fit the viewport; tables scroll within their own region; composer and navigation preserve useful content space. |

## Component standards

- Navigation: clear current location, consistent icon size, stable labels, usable collapsed/mobile navigation.
- Forms: persistent labels, help only when needed, inline actionable errors, associated descriptions. Preserve entered values on failure.
- Dialogs: accessible title, focus containment, Escape/cancel, restored trigger focus, deliberate destructive confirmation.
- Menus/tooltips: keyboard access and meaningful labels; never hide required information solely in a tooltip.
- Tables: align text left and comparable numbers right; clear headers; compact cell padding; bounded horizontal scrolling.
- Cards: group a coherent concept; do not nest decorative cards for every line.
- Notifications: concise outcome with an actionable next step when appropriate; no raw IDs or backend stack traces in routine UI.
- Loading: local skeleton/spinner with status text where useful; do not erase stable content unnecessarily.
- Empty: explain the state and offer one relevant action.
- Error: preserve context and input, explain recovery; distinguish unavailable, offline, rejected and uncertain outcomes.
- Disabled: retain legibility and explain a meaningful prerequisite without redundant prose.
- Success: quiet confirmation; do not require dismissal for routine saves.

## Explicit cleanup

The first source batch removes the Working now header and result inbox from the
foreground chat, removes the captured-settings explanatory paragraph and default
settings caption, and labels the Plan toggle simply “Plan”. Existing settings save
certainty, errors, retry controls, room history and backend records are retained.
This is a UI removal, not a deletion of conversation results or configuration data.

## Migration and verification

Authoritative tracker: https://docs.google.com/spreadsheets/d/1K6KX58asVe5dutXqPcCLA_Bf47949QYLVFQysL1ZmV8

1. Seed file inventory, then expand flows from authenticated running UI.
2. Install shared shadcn primitives and semantic tokens.
3. Migrate shell, navigation and shared controls before page batches.
4. Consolidate obsolete selectors only after their usages are migrated.
5. Verify every inventory row against exact source and rendered evidence.

Use Not started, In progress, Implemented, Verified and Blocked. A source edit is
Implemented only; Verified additionally needs relevant rendered states and
interaction evidence. A missing environment or role is a named blocker, never
silent exclusion. Initial inventory is not a claim of exhaustive live discovery.

## Current implementation ledger

| Batch | State |
| --- | --- |
| Initial source inventory and Google Sheet | Created; live discovery still required |
| Requested chat presentation removals | Source edited; type/lint passed; visual verification pending |
| shadcn primitives/tokens | Button, Input, Textarea, Card, Badge, Skeleton, Table and semantic palette implemented; Account card migrated; rendered verification pending |
| Navigation and execution machines | Shared controls and tokens implemented; desktop/320 top sections observed, remaining states pending |
| Settings page | Buttons, inputs, textarea and native selectors migrated; diagnostic panels removed; type/lint passed, full rendered coverage pending |
| Whole-application migration | In progress; most inventory entries remain unfinished |

Upstream reference: https://ui.shadcn.com/docs/installation/manual

### Implemented foundations

`app/design-tokens.css` owns semantic colors. `components/ui` contains the vendored shadcn new-york primitives with `lib/utils.ts` class merging. Button touch sizes and focus rings are locally adapted. Account settings uses Card and Button; the rest of the inventory still requires migration. Upstream registry: https://ui.shadcn.com/r/styles/new-york/button.json (retrieved October 11, 2026).

NativeSelect preserves browser keyboard and mobile picker behavior. Shared Input and NativeSelect use 44px mobile targets and 36px desktop heights; text fields and textarea use the same visible two-pixel focus ring. Settings retains original action handlers, confirmations and private-token lifecycle. Diagnostic report copy controls are removed from its product surface.

### Shared dialog foundation

`components/ui/dialog.tsx` adapts the shadcn new-york Radix Dialog: semantic card surface, 35% backdrop, 16px viewport gutter, bounded dynamic viewport height with internal scrolling, and a 44px mobile close target. Radix owns modality, focus containment and Escape. Controlled dialogs opened without a DialogTrigger explicitly restore their connected opener. Keyboard shortcuts is the first migrated consumer; other dialogs remain tracked for migration. Motion is static until an accessible shared transition is introduced.

Settings error recovery uses the same Card/Button system and removes report-copy diagnostics. Long API-token and calendar names wrap rather than hiding identity behind ellipses. Operational logging remains outside the product UI.

### Task destination pickers and session entry

`ControlledDialog` centralizes programmatic dialog opening and connected-opener focus restoration. Task Forward and Queue now use it with shared Input and NativeSelect controls; their original transfer/append handlers are retained. The 120 overlay layer preserves task-picker priority over task details. Bot labels and descriptions wrap; selection uses the accent surface and primary border. Old bespoke backdrops, header/close styling, native-field duplication and document-level focus loops are removed from these two consumers. Signed-out entry uses the same Card and Button primitives. These migrations remain subject to recorded full state and device verification.

Composer copy amendment: remove the configuration-intent explanatory block and its unsupported queue action. No routine prose below model controls. Unknown send delivery remains a concise “Delivery unconfirmed.” status with “Check delivery”; original recovery operations and uncertainty remain intact. No hidden automatic retry.

Composer model and reasoning fields use NativeSelect; Plan/Fast and recovery actions use Button. Model-change explanatory paragraphs are removed. Existing controller values, fallback reasoning, supported service-tier selection and save recovery remain unchanged. Mobile reasoning width is 112px to show the current value; controls wrap independently. Actual 390px local component rendering is observed; full workspace/device acceptance remains pending.

Schedules use shared outline actions with a separate destructive text action, semantic row borders and 13px timing metadata. Native details preserves disclosure keyboard behavior with a visible focus ring. Titles and timezone text wrap; actions wrap on narrow screens. The isolated390px expanded long-title view is observed; empty/offline, keyboard and full drawer verification remain pending.

Appearance settings use shared Button, Input and NativeSelect. Shape selection retains aria-pressed; color selection adds a contrasting checkmark and border. Swatches remain44px targets and have a distinct keyboard focus outline. Long names and burst timing wrap. Actual390px disabled-state rendering is observed; online save/recovery and full drawer states remain tracked separately.

Bot details uses semantic surfaces,20px title,13px navigation/metadata and shared close/name/management controls. Removed broad input styling so embedded shared fields keep their own states. Selected tabs scroll into view on section changes. Existing custom drawer focus/history lifecycle is retained pending nested-dialog consolidation;390px actual drawer with Appearance is observed, including selected Settings visibility.

ScheduleEditor is extracted from Workspace and uses ControlledDialog with shared Input/Textarea/NativeSelect/Button. Save/timezone logic remains byte-identical. Errors are announced and busy form state is exposed. Actual390px once-form initial focus and bounded internal scrolling observed; nested-drawer keyboard, custom recurrence, error and desktop states remain pending.

CreateBotDialog and the account-usage/unsupported-teams shells now use ControlledDialog. Create form uses shared fields, explicit offline status, announced errors and busy semantics; original same-operation creation handler remains exact. Draft recovery uses shared outline actions with wrapping rows and retained uncertainty guards. Actual390px offline create form and initial focus observed; full nested/modal/draft recovery state verification remains pending.

Usage and quota presentation owns its styles in usage-history.css instead of spread across global bot/chat styles. Range/refresh/page controls use Button; observation tables use shared Table components. Semantic colors and13px metadata replace bespoke colors and small text. Internal history errors render a concise recovery message; backend data failure remains separate and unresolved. Actual390px error/range layout observed; populated charts/tables and full account states remain pending.

Quota and token charts retain a440px minimum drawing width inside a keyboard-focusable horizontal viewport;14px SVG labels and a44px plot gutter keep axes readable on mobile. Actual390 populated forecast/expanded observation table checked; clipped100% label corrected. Empty forecast arrays no longer enter the two-pace comparison. These observations do not establish backend data correctness or complete usage-state coverage.

Bot navigator rows own their presentation in sidebar-list.css:44px avatars,15px names,13px preview/config metadata,12px timestamps, semantic surfaces and a selected leading rule. Current selection and unread status are exposed to assistive technology. Fixed96px virtualization and ordering remain unchanged; full navigator rendering/keyboard/recovery verification remains tracked.

Navigator search and filters use shared Input/NativeSelect/Button in SidebarFilters, with two readable columns and a full-width team selector. Toolbar controls use shared ghost buttons. Arrow navigation now tracks the focused row and transfers focus after virtual-list rendering; it does not steal focus if the user moves elsewhere. Actual320px search/filter/list and repeated ArrowDown focus observed; full workspace/desktop and preference persistence remain separate verification.

Tasks Create Project and Custom Snooze use ControlledDialog with shared form fields/actions,14px labels, concise description/error text, initial field focus and bounded scrolling. Their original creation/snooze/close handlers remain byte-identical. Escape is contained in the modal before the page shortcut handler.320px create validation and focus restoration are observed; nested Tasks integration, datetime control/device and full busy/error states remain tracked.

Project assignment and deletion now share the same dialog/field/action system. Assignment retains existing selection/create/unassigned values. Deletion retains move-versus-delete choices and destination guards, with destructive styling only on the destructive choice/action; Cancel receives initial focus. Native radios retain keyboard interaction. Existing four save/close handlers remain byte-identical.320px long-name deletion fits; Space activates initial Cancel and restores opener. Nested task flow/device/busy/persistence verification remains pending.

ProjectBrowser is extracted from Tasks into ControlledDialog with shared Card/Button/Skeleton. All/unassigned selection and per-project view/delete callbacks remain unchanged. Cards use semantic selected borders/surfaces, wrapping14px titles and13px counts. Shared row heights align action bars across different title lengths; mobile actions remain44px targets. Actual320 and1280 layouts observed; loading/empty and complete task navigation/device remain tracked.

Task list navigation/search/pins/priority use shared controls in TaskListControls and TaskFiltersDialog. Four task views remain visible at320px by stacking counts below labels; desktop places them inline. Mobile filters use the shared modal, native priority select and44px actions. Capture uses shared Textarea/Button with original growing textarea ref/handlers and admission conditions. Full capture attachment/growth state verification remains pending. Actual320/1280 toolbar render observed; full Tasks composition and device acceptance remain tracked.

TaskRow is extracted into a memoized component using shared buttons, semantic surfaces and visible inline-editor focus. Metadata uses13px text, notes14px; attachment count sits with metadata instead of compressing the title. Mobile swipe rails are24px wide, retaining directional gesture thresholds and callbacks. Actual320px long-title rendering and editor growth observed; real touch/reorder, complete Tasks composition and persistence remain pending. Existing inline-edit checks pass4/5, with the same inherited old Delete-versus-Queue assertion failing on the baseline. State/gesture logic before JSX is byte-identical.

Task detail metadata uses TaskDetailFields with shared Input/NativeSelect/Button,14px labels, aligned desktop rows and13px schedule help. Description and quick actions also use shared controls. The existing custom pull-to-close shell, focus/persistence handlers and attachment media controls remain; this shell is still pending shared-dialog consolidation. Actual320px metadata/validation and1280px aligned form observed using inert fixture state. Full detail composition, attachment actions, nested focus and persistence remain unverified.

AttachmentPicker now uses one shared ControlledDialog on all viewport sizes instead of duplicate custom portal menus. Shared48px menu actions, contained Tab/Escape and opener focus restoration are explicit. Native photo/video/file inputs, accept allowlists, multiple selection, input reset and original callbacks remain. Actual desktop keyboard focus/Escape restore observed; nested Tasks focus, mobile and native file-picker/device acceptance remain pending. The five existing attachment contract checks pass with source paths and portal assertions updated for the extraction.

Attachment recovery uses a shared Card/Button/Input view with14px body and13px status text, wrapping actions, associated disclosure content, and explicit loading/empty states. Existing local queue controller, lease timing, recovery operations and saved-file behavior remain byte-identical before the view return; effects remain in AttachmentQueuePanel. Actual1280/320 populated and missing-bytes presentation observed with inert callbacks;28 existing recovery checks pass. Full storage/event integration, file selection/download and physical-device acceptance remain tracked.

TaskAttachmentMedia consolidates audio/file/image/video rows. Audio receives a full-width player; file labels wrap above separate shared download/delete actions. Images use a two-column mobile grid, video spans the available width, and media actions use44px mobile targets with visible keyboard focus. Formatting helpers are shared. Actual320px file/audio/image rendering observed; media playback, downloads/deletion, desktop layout and full Tasks integration remain pending. Existing five attachment contracts pass; source type/lint/diff pass.

PendingTaskAttachment replaces cramped overlay retries with full-width status cards, wrapping filenames and13px messages. Uploading remains non-actionable; queued/offline is neutral, explicit failure destructive, and original Retry/Remove callbacks remain. Task attachment loading uses Skeleton; list-load errors have an alert and shared Retry control. Actual320 queued/failed/uploading states observed; complete attachment-section composition and real upload outcomes remain pending.

Integrated Tasks preview uses the actual Home, task store and local IndexedDB on the isolated preview origin with network disabled and synthetic rows.320px and1280px page composition observed. AttachmentPicker reports open state to the detail dialog's existing nested-focus guard; actual desktop nested Tab and Escape return to the attachment opener observed. Metadata callback types use explicit string/number overloads. Fresh standalone type check exits0; earlier chained type/lint evidence for701563f onward obscured a metadata callback type error and is superseded by tasks-composed-type.log. Physical touch, native file dialogs, live persistence and complete responsive/state coverage remain unfinished.

Voice memo now uses ControlledDialog and shared action buttons, semantic status/error colors and reduced-motion-aware recording animation. Its MediaRecorder controller is byte-identical. Actual320px full Home→attachment picker→voice idle flow observed without requesting microphone access. Task detail custom gesture shell now shares the border/radius/shadow tokens; redundant coarse-pointer action sizing removed. Recording/review/error, dialog-to-dialog return-focus and physical-device checks remain pending; six relevant existing contracts pass.

### Chained dialog focus

State-driven dialogs can accept an explicit `returnFocus` target. Attachment → voice memo retains the original attachment button because the picker row is removed when the next dialog opens. Actual 320px preview Escape restored the capture attachment button; the prior implementation returned keyboard navigation to the page header. Detail voice and project transitions remain separate acceptance work. Recording and upload behavior is unchanged.
