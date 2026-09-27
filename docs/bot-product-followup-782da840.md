# Bot product integration follow-up

## Honest gallery counts

Later pages label their size explicitly: **Page 3 · 8 files**, rather than implying the entire library contains eight files. A first page with another cursor retains **36+ files**. Complete single-result searches show **1 file**. Month counts on paged views say **6 files on this page**; unknown dates remain in **Date unknown**.

The actual component/browser fixture uses 80 synthetic registered files in temporary native SQLite. At 320, 390 and 1440 pixels, paging through three pages makes exactly two additional list calls, with no inventory enumeration. Last-page size is eight; the unique-name search returns one. No browser exceptions or width overflow. Phone and desktop changed-state screenshots were visually inspected. TypeScript and ESLint for the changed component pass.

```sh
BOT_DESIGN_FOLLOWUP=counts node tests/bot-design-browser.mjs
npx tsc --noEmit
npx eslint app/bots/artifact-gallery.tsx
```

Evidence: `outputs/bot-design-followup/result.json`, `gallery-last-page-{320,390,1440}.png` and `gallery-single-file-{320,390,1440}.png`. Browser is Linux Chromium 154 with emulated sizes, not physical iPhone/Safari verification.

Real history metadata integration is a separate pending backend follow-up; this count checkpoint does not claim that the earlier message-output fixture shortcut verifies it.
