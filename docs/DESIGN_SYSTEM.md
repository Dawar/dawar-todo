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

### Task selection and list surfaces

Task bulk actions use shared buttons in a two-row card: selection count and Cancel remain visible while the action group scrolls horizontally. Actions retain their original eligibility, callbacks and disabled conditions. List groups, empty states and loading rows now use semantic surfaces; skeleton motion respects reduced-motion preferences. Bottom content and notification offsets account for the taller action card. Actual 320px populated selection/Cancel observed; full action combinations, desktop, standalone safe-area and notification coexistence remain acceptance work.

Project assignment can receive the retained attachment opener, using the same chained-dialog focus contract as voice capture. Direct assignment captures its own opener; no project-save behavior changed.

### Task notifications

TaskNotice uses a semantic card with a status/error text area, a persistent dismiss button, a separate Undo action, and a horizontally contained snooze group. All actions use shared buttons; notification errors use the destructive border/text tokens. Existing timing, optimistic operation IDs and undo/snooze handlers remain in the page controller. The card respects reduced motion and sits above the bulk bar. Actual 320px success/snooze, error and busy displays are observed with inert callbacks; full-page lifecycle, screen-reader announcements, standalone safe area and genuine device acceptance remain pending.

### Capture attachment recovery

Capture uses the same PendingTaskAttachment card as task details, with caller-controlled retry availability, disabled state and accurate capture status labels. Filenames and errors wrap at readable sizes; capture cards scroll within their own region. Staged/ready cards say Ready to attach, offline capture says Saved on this device, uploading retains no actions, and only failed capture exposes Retry. Capture project controls and draft-recovery/download actions now use shared buttons. Existing upload/save/remove functions and admission conditions remain unchanged. Desktop file-state fixtures and existing attachment contracts pass; full capture persistence/media/phone acceptance remains pending.

### Task image viewer

The task image viewer uses ControlledDialog for focus containment, Escape and opener restoration, with a bounded image area and shared copy/download/delete controls. Previous/next controls are available at every width; arrows and the existing 50px touch threshold navigate without altering copy/download/delete handlers. Loading and unavailable images have explicit feedback. Actual 320px long-name/image/navigation observed; full nested detail, real touch, clipboard/download/deletion and desktop acceptance remain tracked separately.

### Voice memo state presentation

VoiceMemoRecorder now owns the unchanged recording controller separately from VoiceMemoView. The view can be reviewed with inert callbacks and a local silent audio fixture; it does not itself request microphone access. Oversize/overlong recordings retain the original disabled Attach rule and now explain the reason. Audio controls have an accessible name. Actual 320px review layout and Escape/opener restoration observed; live microphone/recording lifecycle and desktop/full-detail acceptance remain pending. The initial extraction syntax error was corrected before commit; the full 3802-byte controller body matches the prior source. Current page lint has 27 warnings, not a zero-warning claim.

### Tasks page consolidation — October 11

Removed unused page-local private upload entrypoints and their transport types, plus obsolete imports left after extraction. The active attachment-sync → attachment-upload-client path is unchanged; image preparation used by capture and clipboard conversion remains. The existing attachment contract now reads the real shared uploader rather than requiring dead page helpers. TypeScript passes; existing attachment contract checks pass. Page lint is down from 27 to 5 warnings (remaining unused clock/wake helpers and two effect dependencies require separate review). Voice review spacing now fits the 320px preview including its limit error and disabled Attach action. These are isolated source changes, not production acceptance.

### Task save feedback

`TaskSaveStatus` renders saved, saving, offline and error states with labeled text and distinct icons; meaning does not rely on color. Errors wrap instead of truncating. Retry uses the shared button and stacks below the message on mobile. The Tasks page retains the original autosave/retry controller. Actual 320px fixture confirms all four states and an inert Retry callback. Desktop/nested-dialog/device verification remains pending. Task page effects now use effect events for current Undo/deep-link callbacks; unused wake helpers were removed. Exact source type/lint pass with zero page warnings; eight existing snooze/attachment checks pass.

### Bot destinations

`BotDestinationList` is shared by TodoForward and QueuePicker. It uses semantic list markup, shared ghost buttons, decorative avatars, wrapped names/purposes, selected checkmarks/pressed state, bounded scrolling and a status empty state. Existing controller functions choose (1239B), submit (3084B) and metadata (599B) are byte-identical to the prior commit. Actual320 preview confirms long content wrapping and changing the selected bot; no draft/queue mutation was performed. Desktop, keyboard and complete connected-picker states remain pending. Type/scoped lint pass.

### Guest request fields — initial migration

TaskRequestFields now uses shared Input/Textarea/NativeSelect, with field notes associated through aria-describedby. Private password inputs remain uncontrolled refs; file acceptance and callbacks are unchanged. Guest/editor styles use semantic palette tokens; shared field controls are excluded from legacy raw-control overrides. Actual320 fixture shows text, long text, choice and private-field layouts without horizontal overflow; note typography reduced to supporting-text scale. Full guest/editor states, file handling, keyboard, desktop and secure lifecycle remain unverified. Type/lint pass; no live request/submission/private data effects.

### Guest request page and file cards

The guest page uses shared action buttons and PIN/name/recovery-file inputs. GuestFilePreviewView separates filename, confirmation/loading/error state, preview and original download actions using shared controls. The full3201-byte preview verification controller and6687-byte guest page controller remain unchanged. Actual320 fixture renders long filenames plus waiting/loading/error states; no private file/network/submission effect. Type/lint pass. Real image/PDF/download, nested editor, desktop/keyboard and guest end-to-end acceptance remain pending.

### Request editor shell

TaskRequestEditor uses the shared controlled dialog/focus trap; backdrop presses remain non-dismissive. Escape/Close retain existing PIN/link clearing and opener return. Owner controls use shared buttons/inputs/selects/textareas, replacing legacy raw overrides and duplicate modal geometry. Native320 fixture opens the actual editor with an unavailable synthetic context, showing bounded scrolling and controls; no journal admission, network publication or private input. Full enabled/recovery/preview/desktop keyboard coverage remains pending. Initial ref-during-render lint issue was corrected by storing the opener in state. Final type/lint pass.

### Request grouping and draft recovery states

Request editor field legends are direct fieldset children; the remove action follows in its own aligned row. SavedDrafts now distinguishes loading, read failure and a confirmed empty result, and clears stale list/error state when loading a different owner. Existing restoration callbacks and operation guards are unchanged. Type/lint pass; actual delayed-storage/rejection/owner-switch and keyboard coverage remain pending. Editor320 Escape opener restoration was observed on the previous exact shell revision; DevTools issue count is retained as unclassified pending inspection, not claimed resolved.

### Owner-scoped draft recovery

SavedDrafts binds each displayed read result to its owner and rejects a mismatched composer. Owner changes hide stale rows immediately; late restore feedback cannot update a different owner result. A compact Retry repeats only the local read. Actual 320px preview covers delayed read, rejection, Retry, a populated row, owner switch and confirmed empty state; no restore/send effect. Type and scoped lint pass. Full storage, late-promise, desktop and keyboard acceptance remains tracked.

### Guest field grouping

Request groups retain semantic fieldset/legend markup with 16px spacing between fields and supporting group notes. The private model-read opt-in uses an aligned checkbox row instead of the text-field grid, with an 18px native checkbox and wrapped label. Actual320 and1280 previews confirm grouped spacing and checkbox alignment; the800 responsive input did not change the visible viewport and is not counted. Type/scoped lint pass; controller and consent defaults are unchanged.

### Request cards and list

Request cards separate title, status, timestamp and answers. Long titles and filenames wrap; empty ordinary answers are explicit, while file-only answers avoid a misleading empty-answer label. Technical source identifiers remain available behind Source. Private fields remain excluded from ordinary answer rendering. The lazy card still mounts its body only when opened. Request lists use shared ghost buttons with separate title/status and honest loading/empty/offline states. Actual1280/800/320 card fixture covers long content, multiline answers, private-field omission, uncertainty and nested Source; no real request mutation. List controller integration, all statuses and keyboard/device acceptance remain pending. Type/scoped lint pass.

### Long-content pagination

TextPages and ItemPages share compact pagination controls with shared outline icon buttons, accessible names, disabled boundaries and a polite page summary. Mobile targets are44px. Original16384-character slices, item page sizes and index offsets are retained; lazy disclosure mounting is unchanged. Actual320 fixture confirms text offsets0/16384/32768, keyboard Last, terminal disabled controls and final item range21–23. Full message/plan/diff integration, changing input, desktop and screen-reader acceptance remain pending. Type/scoped lint pass.

### Burst controls

Burst Copy/Delete/Queue/Resume/Send/Pause/recovery actions use shared ghost buttons, replacing legacy button geometry and focus overrides. Mobile touch targets remain44px and actions wrap; status/recovery text uses semantic colors and13px sizing. Queue guidance is concise while retaining paused/cancel and unconfirmed-state meaning. Actual320 paused and unconfirmed fixtures render with disabled Queue and no overflowing actions. All original event handlers, admission guards, operation identities and retry calls remain unchanged; no live actions were invoked. Type/scoped lint pass; connected countdown/queue/recovery/keyboard/desktop/device checks remain pending.

### Reply quotes and actions

Reply source/open, cancel and quote actions use shared buttons and semantic foreground/muted/error tokens. Preview text remains capped at three lines and preserves whitespace; labels and errors wrap. The original bounded lookup/quote controllers are unchanged. Actual320 fixture covers long excerpts, foreign source, unavailable result, keyboard-triggered error with visible focus, and cancel. No real history lookup or draft mutation occurred. Type/scoped lint pass; full composer/timeline/user-bubble/desktop/connected quote acceptance remains pending.

### History filters, run cards and timestamps

RunHistoryToolbar provides shared pressed-state filter buttons and a labeled refresh button; RunHistory retains its existing filter/read callbacks. RunActivityCard uses shared action buttons with original admission conditions. Card statuses retain text/icons and use semantic tokens; titles wrap, and supporting times are13px. Message timestamps are12px at all widths with the original minute clock and provenance unchanged. Actual320 fixture shows completed/unconfirmed cards, long titles, attention filtering and disabled offline acknowledgment. Full history/modal/paging/connected actions, remaining legacy activity CSS, desktop and device acceptance remain pending. Type/scoped lint pass.

### History dialog and remaining actions

The nonembedded RunHistory uses ControlledDialog instead of a raw modal backdrop. Its duplicate heading/close chrome is removed; embedded history retains its panel and scroll refs. Remaining history actions use shared ghost buttons with explicit non-submit types. Legacy shell/button overrides and redundant footer copy were removed; a duplicate hover pseudo-class found during review was corrected. Existing data/paging/review callbacks are unchanged. Type/scoped lint/diff pass. Actual offline dialog at320/1280 retains internal list scrolling, fixed title/footer, and Escape return focus. Embedded offline history also renders at320/1280; connected-history and complete page verification remain pending.

### History controls and follow-up selection

Run controls and follow-up actions use shared buttons; selection returns keyboard focus to the collapsed disclosure heading. Existing action journals, admission and same-ID recovery remain unchanged. Activity/history CSS uses semantic colors, and supporting labels are at least12px. Actual320/1280 offline fixtures cover cached original/follow-up entries, unavailable delivery, disabled paging and paused/Stop controls; Tab/Enter selects a follow-up and restores visible disclosure focus. Connected paging, action recovery, full main-stop placement and device acceptance remain pending. No real Stop/resume or native requests were invoked.

### Run replies and question recovery

Run replies use shared action/icon buttons and NativeSelect for saved versions. The measured ComposerInput retains its draft/resize behavior with a short Reply placeholder and46px minimum height. Saved reply text preserves line breaks inside a bounded reader. Run question retry/recovery buttons use the same shared control. Actual320 offline run composer supports empty and long text, visible focus, bounded growth and retained text after reload in a synthetic local draft. No send occurred. Type/scoped lint/diff pass; attachments, recovery versions, question states, desktop and connected acceptance remain pending.

### Missed scheduled-run decisions

RunDecisions uses shared Button and Input primitives with semantic card/error colors and readable13px supporting copy. Reschedule exposes its form relationship; invalid local time is associated with the date field. Original revision, eligibility, receipt and choice handlers remain unchanged. Actual320/1280 fixtures show long titles, wrapped actions and reschedule with disabled empty Save; desktop read-loading and read-error states also render. No real start/reschedule/cancel or native call occurred. Type/scoped lint/diff pass; delivery recovery, connected-state transitions and genuine device acceptance remain pending.

### Retired activity navigation

The unused ConversationActivity navigation and its dedicated nav/provenance CSS are removed. A repository consumer search found only four type-only consumers, now importing ActivityTarget from activity-target.ts. Existing history views retain conversation-activity.css. Type checking and scoped lint pass; this deletion changes no rendered navigation.

### Bot input and approval cards

RequestCard uses shared buttons, Input, NativeSelect and Textarea. Native radio/checkbox inputs retain keyboard semantics with18px controls, visible focus and a selected option border/background. Card titles use normal14px hierarchy rather than small uppercase diagnostics. Nested legends have explicit bottom padding; JSON editors use a128px minimum and monospace type. Original validation, response payloads, locks and request-specific callbacks remain. Actual1280 question selection/missing-answer/rejected-response retention and structured fields; actual320 question/approval action wrapping and final128px JSON editor observed. No real permission or answer was sent. Type/scoped lint/diff pass. Secret/URL/verification variants, busy/accepted transitions and full workspace/device proof remain pending.

Question fields now inherit the existing response lock while pending/accepted, retaining values; schema fields, JSON mode and nested controls follow the same rule. Errors are associated with the card. Question sending/accepted text is announced once visually through the button with a separate screen-reader status. Unsupported device verification uses platform-neutral copy. Actual desktop fixtures confirm pending/accepted radio locks, masked private entry, URL authorization layout (link not followed), and unavailable device verification. Previous rejected-response evidence remains. No real native response was sent; final integrated owner/reconnect and all-variant mobile acceptance remain pending.

### Composer attachments and draft notices

Composer attachments use shared preview/remove controls with readable filename/status tiles. Images are96px (80px with keyboard-open), retaining44px mobile remove targets. File-open errors stay beneath their own tile inside the horizontal tray. Source/staged bytes, owner/queue restrictions, preview contracts and object-URL cleanup are unchanged. Draft Retry is a shared control; notices use semantic colors/padding and omit raw memory-byte diagnostics. Old conflicting attachment button/preview CSS was removed. Actual desktop image/progress/long filename and320 removal plus unavailable-file error checked with synthetic local files; no uploads or real draft changes. Type/scoped lint/diff pass. Locked queue, keyboard-open, successful viewer, upload recovery and full workspace/device checks remain pending.

### Attachment viewer controls

ArtifactViewer uses shared close, retry, zoom, review, PDF-link and download buttons. Header/footer remain fixed while the preview body scrolls; semantic surface/border/text/error colors replace legacy green overrides, supporting labels are at least12px. Native modal, owner/document scope, blob disposal and original read/review/download callbacks remain unchanged. Type/scoped lint/diff pass. Rendered desktop/mobile, focus restoration, PDF/image and unavailable-file checks remain pending; this is source implementation only.

Actual own Chrome checks for the attachment viewer now cover a synthetic local SVG at320/1280, mobile zoom with fixed footer, Escape with visible opener focus restoration, and desktop offline/unavailable original with disabled Download. No real transfer/review or server mutation occurred. PDF/document/reconnect/error and integrated workspace coverage remain pending. Evidence: private artifact-viewer-observation.json.

### Artifact gallery

Gallery search/filter fields and navigation, recovery, paging and file-card actions use shared Input, NativeSelect and Button. File names are14px and metadata at least12px; mobile controls retain44px targets. Ordinary surfaces use semantic colors and empty headings are concise. The PDF badge is above the thumbnail message to avoid overlapping the unavailable-preview text at320px. Existing queries, cursors, debounce, owner cache scopes, lazy previews, discovery and download handlers are unchanged. Actual own Chrome1280 populated and320 populated/PDF filter/empty/error fixtures observed; no real file API/download/upload effect. Type/scoped lint/diff pass. Keyboard/search/selection/paging/reconnect and full workspace coverage remain pending; final semantic error color change has not yet been reobserved. Dedicated fixture RPCs returned only synthetic data.

### Shared files inside chat and search focus

ReturnedArtifact uses the shared outline control with wrapping14px filenames and12px metadata; view-all is a shared link-button. Original delivery/provenance filtering, IDs, owner preview and six-item bound are unchanged. Gallery clear-search is outside the field label and restores focus to the input. Actual320 search Budget narrowed the fixture list; Tab/Enter cleared it and restored input focus. Actual320 returned Markdown/PDF/image cards wrap without horizontal overflow, and the Markdown card opens its offline viewer. The viewer no longer says an unavailable original is ready to save; the download instruction requires an original URL. Type/scoped lint/diff pass. Final offline-copy reobservation, desktop returned cards, keyboard opener restoration without HMR and full workspace checks remain pending. No real files/messages/API mutations occurred.

### Document preview and review foundations

Document/PDF reviewers use shared buttons and Textarea, with shared Input for PDF page selection. Native file picker, original note/attachment journals, locks, send/reconcile callbacks and sanitized preview boundaries remain unchanged. Reviewer CSS retains layout/resize rules while removing competing control treatments; PDF toolbar wraps at narrow widths. Document surfaces and supporting states use semantic tokens. Markdown tables have160px minimum columns and normal word wrapping inside their existing horizontal scroller; code blocks retain independent scrolling. Actual320 markdown headings/list/quote/table/code and oversized-document error/Retry observed. Initial table broke words at single letters;120px intermediate fixed column collapse but still broke long words, final160px/normal wrapping awaits reobservation. Type/scoped lint/diff pass. Reviewers themselves, desktop/keyboard, HTML and integrated durable feedback acceptance remain pending; no real feedback or API effect.

### Route visualizations

RouteVisualization uses NativeSelect with a readable label and consistent24px heading; mobile stages stack and desktop stages keep actor/detail columns. ReturnedVisualization uses wrapping outline controls with the same offline/owner/index/page limits. Actual320/1280 fixtures show a long offline reference, route layout and Down/Enter route selection with visible focus and changed stages/note. Original data-only parser and lookup/index handlers are untouched; no indexing/API effect occurred. Type/scoped lint/diff pass. Online recovery/indexing, full report embedding and workspace coverage remain pending. Final160px normal-wrap Markdown table was also reobserved at320 with bounded horizontal scroll and readable words.

### Review form accessibility and rendered states

Document/PDF feedback fields use unique React IDs and reference their error paragraphs. Document read-only notes use a muted surface; error text uses the destructive token. Actual DocumentReviewer at1280 shows side-by-side document/notes, entered text retained through a synthetic pending-state toggle, visible input focus and disabled offline send. At320 the document and notes stack; scrolling reaches notes/error/offline status/send without horizontal overflow. Composer methods in this fixture were inert/in-memory: this proves presentation, not durable save or real delivery. Final error/field layout reobserved after HMR; pre-HMR entered-note observation retained separately. PDF reviewer, locked typing, actual persistence/reconnect and full workspace/device acceptance remain pending.

### PDF reviewer rendered checks

Actual PDF.js plus PdfReviewer rendered a deliberately invalid local PDF (bounded error/Retry and disabled controls at320), then a two-page vector PDF. At320, toolbar wraps, Previous/Next select the expected page, feedback is page-specific, and the Page2 note shortcut returns to its retained in-memory note. At1280, page and notes remain side-by-side with reachable attachment/send controls. Pending fixture state disables page/input/attachment/note controls and retains text. Send remains disabled offline. This uses an inert composer and synthetic local bytes; no upload/send or durable save is claimed. Existing type/lint proof applies to unchanged c143823 source; full persistence/reconnect/attachments/password/fonts/keyboard and integrated workspace acceptance remain pending.

### Goal panel

Goal controls and editors use shared Button/Input/Textarea/NativeSelect. Header and supporting copy use semantic foreground/muted tokens; concise status wording replaces native implementation language. Clear confirmation is destructive; all original freshness, owner/thread, Stop/input, fingerprint and exact-action guards remain unchanged. Actual1280 and320 offline fixtures render a long paused objective, Full objective disclosure, accounting and disabled actions. Type/scoped lint/diff pass. No Goal action was invoked. Connected edit/create/clear confirmations, stale/unknown/recovery variants and integrated drawer/keyboard acceptance remain pending.

### Private input forms

Private forms use shared Button and Input controls, semantic surfaces/text/errors, 14px body copy, 12px status and mobile 44px targets. Consent remains an explicit unchecked native checkbox; its privacy explanation stays visible. Existing memory lifetime, encryption, same-submission retry and owner guards are unchanged. The private-input modal now uses ControlledDialog for focus containment, Escape and explicit opener return, with outside dismissal prevented to preserve open input. Actual isolated 320px offline form/disclosure/scroll and Escape focus return checked; connected transfer, busy/sealed/error/terminal states and full-workspace integration remain pending.

### Teams

Teams uses ControlledDialog, shared Button/Input/NativeSelect/Textarea, semantic cards and a two-column desktop/one-column mobile grid. Action rows align across unequal titles; mobile membership controls wrap after the bot name. Existing dirty-discard confirmations, same-operation recovery, owner/revision guards and mutations are retained. Actual offline 320/1280 long-title lists checked; editor/empty/error/pending/keyboard/full workspace checks remain pending.

### Confirmations

`ConfirmDialog` uses the shared dialog and footer, focuses Cancel first, and supports destructive confirmation styling. Teams uses it for dirty editor dismissal, back navigation and replacing edits with the latest data. Cancelling retains the editor and returns focus; no action runs before confirmation. Actual 320px nested creation-editor confirmation and keyboard Cancel retained draft/focus. Existing read-only fixture editor layout checked at desktop/mobile; connected mutation/recovery remains separate.

### Voice / Operator

Voice uses ControlledDialog with initial focus on Close, outside dismissal prevented, and existing end-before-close plus unmount cleanup preserved. Start is primary; other call/history controls use shared outline Button and routing uses NativeSelect. Call cards retain timestamps on mobile, allow full names to wrap, and use semantic typography/surfaces. Actual320 ready dialog and Escape opener focus checked without starting a call. Connected media/control states, desktop/history/paging/error/question states remain pending; no provider or microphone action was exercised.

### Upcoming work and native plan snapshots

WorkOverview and AutomaticInbox use shared outline buttons and their own semantic stylesheet; their old branches were removed from the shared single-thread stylesheet. Text distinguishes queued, accepted and uncertain execution without changing admission/read/recovery logic. Pause guidance is concise, with its action below the message at narrow widths. Native plan status uses semantic colors plus explicit text/weight; partial and last-recorded notices remain visible with short copy. Actual synthetic320 upcoming rows/paused-disabled action/long plan checked; connected Resume and native work effects are not part of this fixture.

### Message detail, tables and diagrams

Tool disclosures use semantic borders/text and 44px minimum summary targets; output remains bounded monospace text. Status icons reflect recorded running/completed/failed/declined/interrupted states, with no success check for unknown status; explicit nonzero exit or unsuccessful dynamic result is a failure. Message tables retain native semantics and an independently focusable horizontal viewport only when overflowing, with semantic header/border/scroll colors. Diagram source toggles use shared ghost icon buttons; the lazy strict Mermaid renderer reads shared palette tokens at initialization and keeps the existing sanitization and size limits. Actual1280/320 tool outcomes/table overflow/proposed plan and diagram/source toggle observed. Streaming/invalid-diagram/keyboard paging/attachment scope/integrated chat remain pending.

### Inline attachment images

Inline images retain lazy loading and bind download/display state to the current owner, bot, attachment and attempt. Obsolete requests are aborted and object URLs revoked. Loading, offline and failed states use short labels; the shared Retry image button repeats only the attachment read. Decode failures also expose retry. Actual320 error/retry/success/offline and owner-change states plus1280 success observed with local SVG blobs. Connection changes remount scoped display state, preventing a revoked prior URL from reappearing after reconnect. Full chat integration, late-result races and decode-failure verification remain pending.

### Message navigation rail

The dense message rail retains 24px non-overlapping keyboard-selectable hit groups, bounded loaded-history geometry and explicit coverage descriptions; it uses semantic palette tokens. Dense groups open ControlledDialog with shared outline buttons and the existing 40-choice pages. Choices wrap at mobile widths; the footer wraps rather than clipping. Actual1280/320 dense choices, Escape returning focus to the rail, Enter reopening, second-page range and exact selected ID were observed with synthetic history. Empty/single-tick/earlier-loading/error/room/integrated geometry still need rendered acceptance.

### Global cascade and storage notices

The semantic palette now also owns page foreground/background and warning colors. Base resets live in the Tailwind base layer so explicit component typography (including monospace inputs) can win; default borders use the shared border token. The mobile16px input rule remains to prevent focus zoom. Root viewport keeps device width and safe-area support without disabling user zoom. Physical pinch-zoom acceptance remains pending.

StorageLifecycleNotice uses shared buttons, semantic warning/accent surfaces and short action-oriented copy. The existing update guard, worker readiness, error handling and human-only refresh remain unchanged. Actual320 blocked/upgrade/dismiss/update/guard-error and1280 update-error layouts checked with local lifecycle state; no worker update, database mutation or navigation occurred. Full app safe-area/zoom/multitab and remaining notice-state checks are unfinished.

### Legacy Assistant retirement

`/assistant` already redirects to `/bots`. The unreferenced legacy AssistantWorkspace and standalone Assistant attachment/voice controls are removed, eliminating competing inactive UI. Assistant database/API/offline records and existing runtime contracts remain untouched. The existing assistant test now checks retired files/current redirect and the current storage-adapter delegation; both existing cases pass, including bearer-auth rejection. No new route or real model operation was introduced.

### Bot and team setup approvals

Setup approvals use shared buttons, semantic cards, wrapping action summaries and explicit human-readable states. Original IDs remain available under Request details. Confirmation remains unchecked and scoped to the original request revision; approval/revocation/recovery logic is unchanged. Actual1280/320 long-action layouts, disclosure and keyboard checkbox focus/Space were observed with read-only fixture requests. No approval was submitted. Offline/empty/error/revoke/recovery and full drawer acceptance remain pending.

### Earlier-work controls

The retained earlier-work recovery panel uses shared outline buttons and semantic card/status/error colors, readable13px metadata and wrapping44px actions. Wording distinguishes paused, unconfirmed and waiting work without duplicate instructions. Current-work selection, saved-action recovery, Stop scope and Activity navigation are unchanged. Actual320/1280 synthetic running/paused/uncertain rows and offline-disabled Stop observed; the paused Activity button returned its exact original fixture run ID. Connected Stop/recovery, empty/overflow and full history drawer remain pending.

### Screen loading and recovery

`ScreenLoading` and `ScreenError` centralize shell/Settings feedback. Loading has an announced status and a motion-safe spinner; errors use Card/Button with retry and a task destination, without exposing raw exceptions. Settings retains its operational error logging; shell route caching, launch choice and navigation logic are unchanged. Skeleton now uses a neutral muted surface and motion-safe animation. Actual1280/320 error layout and320 Retry-to-loading transition observed. Full router failure/retry/back navigation, keyboard and reduced-motion emulation remain pending.

### Desktop viewer

Desktop toolbar and remote-keyboard buttons use shared outline controls. The full-screen viewer retains a locally scoped dark semantic palette around the remote display, original custom focus/keyboard handling, input/lease/viewport logic and safe-area layout. Names wrap; identity icons do not shrink; toolbar groups wrap on narrow screens. Browser retention uses NativeSelect, whose values now explicitly use normal weight independent of bold labels. Actual320 preview/retention and320/1280 disconnected viewer/More disclosure observed with a missing-relay fixture that prevents session acquisition. Connected input, remote keyboard, retention mutation and physical touch acceptance remain pending; no native desktop/session/control effects were used as checks.

### Retained bot discussion receipts

Peer message cards and owner discussion controls use shared outline buttons, semantic surfaces/borders/text, readable status labels and wrapping44px actions. Mobile cards use the available width. Offline body hints are short and placed below their action. Paging, owner/revision checks, native intake labels and saved-action recovery remain unchanged. Actual1280/320 offline receipt and paused-control layouts observed with a synthetic read-only root; no Continue/Stop effect submitted. Connected body/error/recovery/paging and complete conversation alignment remain pending.

The desktop keyboard's text field now follows its dark semantic scope, and manual paste stacks at narrow widths. Disconnected controls, More keys and keyboard focus were observed; remote input is deliberately absent from the fixture. Connected IME/paste and physical-device acceptance remain pending.

### Collaboration rooms

Room navigation, editor, composer and scoped history actions now use shared Button/Input/Textarea/NativeSelect. Existing member checkboxes retain native semantics with44px labels and a visible keyboard ring. Selected rooms expose aria-current, names wrap, and room surfaces/statuses use semantic tokens. Message paging's sticky selector now targets the actual feed-content wrapper. Draft storage, addressed-recipient selection, exact saved-post recovery, owner/context checks and message anchors remain unchanged. Actual320 navigator/long selected group and create-form inspection started; full conversation/composer/native-history and connected mutation acceptance remain unfinished.

Room conversation verification found that always-visible addressing controls displaced the chat. Recipients and message kind now sit in a native disclosure; the text field, short delivery hint and Send share a compact composer. Paging labels are Earlier/Latest with full accessible names. Empty conversations have a visible starting state; long room titles wrap without a fixed-height header clip. Actual320 populated and empty conversations plus1280 populated layout observed using synthetic read-only pages. Existing draft versions, recipients, intent recovery and submission conditions are unchanged. Expanded addressing, connected delivery/recovery, room native-history states and physical keyboard/device acceptance remain pending.

Scoped room activity uses concise loading/offline/error/empty feedback. Earlier/Newer and question paging controls are shown only when those pages exist; Refresh remains available. Original context/thread IDs live under Conversation reference. Rendering an empty320 page and a failed320/1280 read confirmed readable spacing and a single recovery action. Reader validation, scoped native events, request answers, original receipt recovery and downloads are unchanged. Nonempty history, questions, late events and integrated room acceptance remain pending.

### Task-list summary

TaskListSummary centralizes the list heading, count/saving status, selection and clear-filter actions. Shared ghost buttons replace small bespoke links; both groups wrap at narrow widths. The task screen passes its existing selection/filter callbacks unchanged. Its sync pill now uses semantic foreground/background colors. Desktop populated/empty/saving states rendered; full task-store/offline and responsive integrated-page acceptance remain separate.

### Activity metadata

Compact activity previews, counts and elapsed labels use13px muted semantic text, preserving the two-line preview clamp and tabular clock digits. The elapsed tooltip is concise. Native timing matching, hidden-page subscription, offline freezing and unknown suppression are unchanged. Actual320 matching live elapsed/unknown suppression, long preview clamp and offline stale state observed in a local timing fixture; full timeline/visibility/terminal transitions remain pending.

### Route boundaries and sign-out

Portable-session and public-route loading states now reuse ScreenLoading; an optional label supports the protected-form fallback. URL resolution, owner-screen mount guards, cross-tab sign-out and preserved drafts remain unchanged. SignedOut already uses shared Card/Button and semantic typography. Desktop render inspected; responsive/focus and full auth transition verification are separate.

### Markdown previews
Task and form Markdown previews use semantic card, foreground, muted and primary tokens. Empty previews retain a dashed boundary. Headings follow the shared hierarchy; code and tables use readable 13px text. Wide tables and code scroll within their own regions, preserving the surrounding mobile layout. Table regions and links have visible keyboard focus. Sanitization and URL handling remain unchanged.

### Recovery and transient feedback
Task sync recovery uses a semantic warning surface, a concise retained-change explanation, expandable saved payloads and shared retry/download buttons. Hidden payload details preserve recovery context without dominating the task list. Pull-refresh feedback uses the popover surface and 13px label; the opening route uses shared ScreenLoading. Existing gesture thresholds, persistence, retry and navigation behavior remain unchanged.

### Task-row status and actions
Task rows use a restrained semantic palette: destructive for urgent/overdue, warning for high priority/snooze/offline, muted for ordinary metadata, and accent for queued status. Context and recurrence share secondary styling rather than unrelated colors. Badge labels remain textual; long metadata wraps within the row. Swipe surfaces pair their foreground/background tokens. Actions, identity, gesture thresholds and persistence are unchanged.

Task sync status occupies normal document flow beneath navigation. It must not float over recovery notices or task controls; long reconnect/auth labels wrap naturally.
