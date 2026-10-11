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
| Whole-application migration | Not started |

Upstream reference: https://ui.shadcn.com/docs/installation/manual

### Implemented foundations

`app/design-tokens.css` owns semantic colors. `components/ui` contains the vendored shadcn new-york primitives with `lib/utils.ts` class merging. Button touch sizes and focus rings are locally adapted. Account settings uses Card and Button; the rest of the inventory still requires migration. Upstream registry: https://ui.shadcn.com/r/styles/new-york/button.json (retrieved October 11, 2026).
