# Bot draft release review — 2026-09-26

Reviewed integrated base **9a60ceaa897f1c08f89d09a3eb25b6633da5468b** (draft pass 62e64c4 plus task upload recovery 80a3826). This review adds independent fixtures, three focused controller regressions, and one controller correction. It does not change workspace/client/history, bot layout, task source, the performance harness, service/relay protocols, or release state.

**Release review is not green:** real Chromium durability scenarios pass with the controller correction, but the browser command exits 1 on the unresolved layout findings below. The manager has routed composer layout to the chat worker. Task panel overflow also requires its owning worker. No merge, push, deployment or service restart was performed.

## Reproduced and corrected in the draft controller

Tab A received an ambiguous send response. Tab B reconciled the same operation and committed success. Native BroadcastChannel refreshed A to the confirmed record, but A's independent `actionError` still said “Send acknowledgement is unconfirmed.” The browser assertion failed on the original controller. A late uncertain response after another tab's confirmation could produce the same false warning.

Uncertainty now lives only in the durable operation's error, which the existing status component displays. Retiring that operation also retires its warning in every refreshed tab. Definitive rejection still leaves its correction message and the draft. This changes neither operation identity nor compare-and-clear/storage semantics. Three new unit regressions cover other-tab confirmation, a late uncertain callback, and definitive rejection. The real-browser scenario also checks visible warning appearance and removal.

## Native browser evidence

`node tests/bot-release-review-browser.mjs` bundles the real React workspace, SiteHeader, composer/service/store/client and AttachmentQueuePanel, plus freshly compiled application CSS. Each run creates and deletes its own temporary Chromium profile; two real pages share the test origin. IndexedDB, Blob/File bytes, object URLs, BroadcastChannel, storage events, visibilitychange, pagehide, top-level navigation, browser back and reload are native browser mechanisms.

The backend and identity are synthetic. A local HTTP harness controls acknowledgements and supplies responses to actual `BotsClient.receive` through a socket adapter; no real WebSocket service or native Codex mutation runs. Actual `BotsClient.start`/`session` handle cached identity and local HTTP 503/403 responses. Only shell routing is substituted; the real header markup and styling remain.

The final run passed these assertions before failing the layout gate:

- A native readwrite transaction blocks both pages' writes, forcing two text edits from the same base. Both text versions survive (normal plus recovery), both files persist, both tabs converge through BroadcastChannel, and PNG previews decode from local bytes.
- Actual client handling of an untyped EPIPE response retains the submitted ID. A second tab retries that same ID. With a native transaction held, newer text and a new file race the acknowledgement. Only submitted normal-slot content clears; the other bot's text and bytes survive. The synthetic backend records one unique send for two attempts.
- Queue editing remains separate from the normal draft through native tab backgrounding, final input followed by pagehide/navigation, browser back and offline reload. File bytes recover. Offline here means bot transport/session unavailable; the local fixture server still serves the application.
- A failed upload survives reload, then resumes with the same upload ID and original bytes. Reconnect does not submit unsubmitted text.
- A real local HTTP 403 occurs while an already-dispatched queue update awaits response. Both tabs revoke visible access through auth BroadcastChannel/storage events without deleting data. The late response cannot clear the original owner's operation. A different synthetic owner sees an empty composer; restoring the original cached identity offline recovers its data. Reconnect reconciles the original queue operation ID. There are exactly two unique synthetic backend mutations overall: one send and one queue update, each attempted twice.

## Layout release blockers

All dimensions below are CSS pixels in HeadlessChrome **154.0.0.0 on Linux**. Phone emulation uses CDP device metrics. Keyboard simulation overrides `visualViewport.height` and dispatches resize while the real textarea is focused; it is not an actual keyboard/device measurement.

The composer scenario uses the real header, offline banner and controls, a 30-line draft, six small PNGs, two text files (one long filename), and long recoverable upload errors including unbroken tokens. No page-wide horizontal overflow was found in the bot screen, and textarea/status/file strips can scroll internally. Nevertheless, the fixed-height conversation clips the input:

| Layout | Visible height | Input height | Input bottom | Result |
| --- | ---: | ---: | ---: | --- |
| 390 × 844, full viewport | 844 | 180 | 810 | Input fits |
| 390 × 844, simulated keyboard | 400 | 180 | 706.05 | Input hidden below screen |
| 320 × 640, full viewport | 640 | 180 | 657.09 | Input already clips |
| 320 × 640, simulated keyboard | 330 | 180 | 657.09 | Input hidden below screen |

The status area is 202.55 px tall at 390 px width and 153.59 px at 320 px width; `24vh` follows layout height rather than the reduced visual viewport. Its long unbroken error token produces a 3,154 px internal scroll width. Correcting only that status cap cannot fix the combined header/controls/files/textarea height budget. **Ownership dependency: chat worker's workspace/bots.css layout.** No layout source was edited here.

The real task AttachmentQueuePanel is seeded through its public native-IDB queue APIs with saved bytes, blocked errors and one missing original. At 320 × 640 and 320 × 330, its missing-file chooser's flex label/input is 303 px wide at x=29, extending to x=332. Page scroll width becomes **332 px on a 320 px root**, and Chromium expands the layout viewport. The `max-w-full` file input is constrained by an oversized flex label. At 390 px, it fits. Long error/name text wraps and all recovery actions remain vertically reachable by page scrolling; the task panel uses normal document scrolling. **Ownership dependency: task worker's attachment-queue-panel.tsx.** No task source was edited.

The browser gate collects all layout findings and then asserts that the list is empty. It deliberately remains failing against this base; there is no expected-failure allowance. It also requires an input at least 38 px high, input bottom within the visible viewport (1 px tolerance), internal scrolling, and no page-wide horizontal overflow. Rerun on the corrected integrated commit without loosening these assertions.

## Checks actually run

- `node --test tests/bot-composer-cross-tab-review.test.mjs tests/bot-composer-durability.test.mjs tests/bot-client-recovery.test.mjs` — **31/31 passed**.
- `npx tsc --noEmit` — **passed**.
- Targeted ESLint for the changed controller and three new test/fixture files — **passed, no warnings**.
- `npm run build` — **passed**.
- `node tests/bot-release-review-browser.mjs` — durability/owner/transaction scenarios passed, zero uncaught browser errors; **exit 1 on the layout findings above**.

Generated local evidence is in `outputs/bot-release-review/`: `result.json`, `run.log`, `build.log`, `composer-390.png`, `composer-320.png`, and `task-recovery[-bottom]-{width}-{height}.png`. These synthetic screenshots/logs are ignored artifacts, not committed payloads. The runner records the tested Git HEAD for subsequent integration reruns. The review run at the base above included the uncommitted controller correction described here; this note and correction are committed together.

No physical iPhone, Safari/WebKit, PWA standalone safe-area behavior, real keyboard, OS kill, storage eviction/disk failure, deployed service worker, deployed auth session, live user data, or coordinated backend release was tested. Native transaction completion/navigation success in desktop Chromium does not establish physical OS-kill durability. The initial pass's fake-IDB fault tests were rerun; no new physical storage-failure claim is made. Root owns integrated full-app/backend checks and the release checklist.
