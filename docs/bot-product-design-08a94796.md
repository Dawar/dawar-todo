# Bot product design pass — core checkpoint

Base: live `a5f68a9`. Gallery/backend integration and quota presentation are still in progress; this checkpoint is independently reviewable, not a completion claim.

The supplied IMG_0045/46/47 were inspected. The exact empty-height sequence reproduces against the live source: type a long draft, then clear it through the controller without focusing the input. The textarea stays **180 px high, empty and unfocused**. With the new value/layout measurement it returns to **40 px** at 320, 390 and 1440 widths. Placeholder text cannot determine height. Restored draft, send-clear, bot switch, Activity hide/show and font-change checks pass.

Core changes:

- Dedicated ComposerInput measures actual value before paint and reacts to width, fonts, visual viewport and Activity restoration; input remains capped and internally scrollable.
- Routine empty/saving/saved disclosures removed. Persistence is unchanged and immediate. A genuinely slow save becomes visible after two seconds; storage/transfer/conflict/uncertain-send recovery stays actionable.
- Latest control is a floating overlay, hidden at bottom/short threads. User reading position stays anchored; composer resizing, tool expansion and streaming preserve follow-latest.
- Calm green/neutral typography, spacing, focus treatment and 40 px composer actions. Work disclosures have a clear arrow and correct singular/plural labels. Conversation-tail global artifact dump removed; dedicated gallery is the next checkpoint.
- Real loading skeleton, empty introduction and recoverable history error presentation. No native/user storage changes.

Verification at this checkpoint: 39 focused composer/cross-tab/timeline tests pass; TypeScript passes; scoped ESLint passes. The independent release-browser assertions remain intact and pass with no findings. Actual production component browser preview covers populated/empty/loading/offline/error/recovery/keyboard at 320/390 and desktop, with no browser exceptions. Worker inspected representative screenshots and iterated after finding a follow-latest resize issue during recovery display.

```sh
node tests/bot-design-browser.mjs
BOT_DESIGN_BASE=a5f68a9 node tests/bot-design-browser.mjs
node tests/bot-release-review-browser.mjs
node --test tests/bot-composer-durability.test.mjs tests/bot-composer-cross-tab-review.test.mjs tests/bot-timeline-098e1aae.test.mjs
```

Screenshots and JSON: `outputs/bot-design/` and `outputs/bot-design-before/`. Start with `empty-height-reproduction-390.png`, `chat-390.png`, `keyboard-320.png`, `recovery-390.png`, `loading-390.png`, and `chat-1440.png`. All are running React components with native browser IDB and synthetic fixture data. Chromium emulation is **not** physical Safari verification. No services were restarted or deployed.
