# Plan/Fast independent-review corrections

Corrects the three blocking findings on `319bba05d1457766db68bfb2dd7bfaa7e00e3746`, on isolated branch `codex/bot-typing-recent-3d829950` above main `af1837204eacf8930462c0c9e7ecd3305a3b9f6d`. No real bot settings/messages, drafts, native history or shared main were changed. No deployment, push or service restart was performed. `public/sw.js` now names shell generation **37**; DB version is unchanged. The earlier v140 release's stale-shell possibility is separate from the source defects below.

## Three corrected sequences

The executable diagnostic uses the actual controller, client and bridge runtime with synthetic data, controlled RPC completions, injected localStorage failures and a disposable SQLite store. These are application-level synthetic results, not live native timing or iPhone measurements.

| Reviewed failure | Corrected actual-module result |
| --- | --- |
| Accepted Plan; an unrelated event advances incomplete cached state to cursor 13; complete Plan snapshot 12 is discarded and confirmation clears. | Complete snapshot 12 is applied; unrelated event 13 retains the visible event cursor. Plan remains on. Only the submitted `mode` is confirmed; an independently updated effort of `ultra` is not overwritten by `high` in the save receipt. |
| Failed localStorage write is caught but the mutation still leaves the browser. | Failure on either the initial intent write or the exact operation preflight produces **0 RPCs**. The latest visible intent remains in memory with an actionable **Retry storage** error. The transport diagnostic checks the exact pending ID/parameters and latest intent already on disk at every dispatch. A failed recovery preflight also produces **0 additional RPCs**. |
| A snapshot happens to match the requested Plan value while its operation is uncertain, so Check sends a successor with a new ID. | Matching full snapshot 12 leaves the queue blocked with the original ID, including after controller reconstruction from storage. **Retry saved change** explicitly sends the same ID and exact parameters. Only the terminal result for that operation permits the queued reversal under a new ID. A retry rejected locally as `not-sent` keeps the original uncertainty and sends no successor. |

Additional boundary calculations passed: event 14 is retained over complete snapshot 13; delayed complete snapshot 11 cannot undo snapshot 12; provisional cached cursor 99 cannot prevent hydration from full snapshot 12. A full read requested after a successful operation can reconcile a later external change even when its numeric cursor is below a provisional cached cursor; submitted fields are not pinned forever. In the real runtime with a controlled native stub, two concurrent requests with the same ID produced **1 native settings mutation**. A subsequent request with that completed ID returned the stored terminal result with **0 additional native mutations**.

## Implementation and compatibility

- `app/bots/client.ts` distinguishes a complete server-snapshot watermark from a provisional cached/event cursor. Latest patches per bot/request are replayed over older complete snapshots; patches already covered by a full snapshot are removed. Owner detachment resets both watermarks and patches. Existing owner/connection-epoch checks still reject stale-owner replies. This repairs missing state rather than merely masking it in the toggle component.
- `app/bots/composer-settings-controller.ts` overlays only submitted fields from exact successful operation receipts. Confirmation clears through a full read issued after that terminal success, not through arbitrary event activity or matching values. Immediate desired state remains separate and rapid taps still coalesce into one ordered successor. **The original observation-only five-second backoff was insufficient:** it could leave an acknowledged overlay pinned indefinitely after a failed read. The bounded scheduled replacement is documented below.
- Every send, including recovery, must successfully store the complete latest intent plus exact pending identity/parameters first. Storage errors prevent dispatch. Owner/bot-scoped persisted records migrate v1 pending operations and desired intent; v1's unsafe whole-Bot confirmation overlay is discarded. Restored pending operations require explicit same-ID recovery. No critical draft/history store is modified.
- `app/bots/composer-settings.tsx` replaces the misleading Check action with **Retry saved change**, and adds **Retry storage** / **Paused** states. A same-ID retry may finish an in-flight operation, retrieve its terminal result, or dispatch it if the server has never seen it. It is not described as read-only. Uncertainty is not converted into success based on setting values.

Native settings ordering and future-turn semantics from `319bba0` are unchanged: the bridge awaits native settings acknowledgement before committing bot settings. A native queued turn starting before that acknowledgement retains its previous settings. No active turn is restarted. This correction requires no additional bridge change; the prior `319bba0` rejection-certainty fix still needs the manager's coordinated integration/reload.

## Rendered inspection

Used `node diagnostics/bot-feed-preview.mjs` and its interactive CDP helper against the actual workspace in disposable Chromium, with public synthetic history and held settings replies. No automated browser suite was run.

Tap Plan on, reverse Plan off, and enable Fast before the first reply: all pressed states changed immediately, neither toggle was disabled, and there was **1 request** before acknowledgement. The first terminal reply caused exactly **1 coalesced successor** (`mode: default`, Fast tier), for **2 requests total**. The latest visible choices did not flip during either acknowledgement. Separate rendered storage and uncertainty cases showed **0 requests** on storage failure, a blocked queue after matching Plan state, an explicit same-ID recovery, then a new-ID reversal only after its terminal response.

| Viewport | Body width | Settings row | Composer input |
| --- | --- | --- | --- |
| 320px | 320px | 54px | 40px |
| 390px | 390px | 54px | 40px |
| 1440px | 1440px | 48px | 40px |

Personally inspected the actual screenshots. Normal controls, storage failure and unconfirmed recovery fit without horizontal overflow. Local disposable evidence is in `outputs/bot-typing-recent/`: `composer-v141-final-320.png`, `composer-v141-final-390.png`, `composer-v141-final-desktop.png`, `composer-v141-pending-390.png`, `composer-v141-storage-320.png`, `composer-v141-storage-390.png`, `composer-v141-unconfirmed-320.png`, `composer-v141-unconfirmed-390.png`, `composer-v141-recovered-390.png`. These ignored images are available for manager review; they are not part of the source commit.

## Read-reconciliation liveness correction after af997cd

Independent review accepted the three corrections above but found a remaining failure: Plan-on succeeds, its post-success snapshot fails, an external Plan-off event arrives one second later, and the observation backoff suppresses the only subsequent read. At eleven seconds, idle UI still shows Plan on with no error. The earlier report's claim that subsequent observations provided sufficient recovery was wrong.

The controller now schedules an initial confirmation read plus at most **three retries**, delayed **2, 5 and 10 seconds after the preceding failed read settles**. The scheduled wake-up is independent of React renders and unrelated events. After the first failed read, a truthful message explains that the change was saved but current displayed settings may be out of date. **Refresh settings** starts a new bounded read cycle; it is disabled while its confirmation read is in flight. On exhaustion the message/action remain, with no automatic timer or further reads.

Lifecycle ownership is explicit in `ComposerSettings`' layout effect and its cleanup, including React Activity hide/show. Bot navigation/unmount, page visibility/pagehide, offline state and owner mismatch cancel or guard waiting timers. Returning to an eligible foreground view or reconnecting resumes a bounded cycle. A new acknowledged operation starts its own cycle. There is at most one confirmation timer and one confirmation read in flight per controller; the next timer is installed before notifying subscribers, preventing an observation from bypassing the backoff. An in-flight read may finish while hidden, but cannot create hidden follow-up activity.

Code-path review of the counterexample (not an executed timing measurement):

| Sequence | Resulting path |
| --- | --- |
| Initial Plan acknowledgement followed by failed snapshot at t=0 | Keep submitted-field receipt; display refresh error; schedule a read for t=2s. |
| Authoritative external Plan-off event at t=1s, then idle | Observation finds the existing timer and does not reset it. No subsequent render is needed. |
| Scheduled read completes with authoritative Plan off | Clear acknowledged overlay and refresh error. Current Plan off becomes visible; queued desired intent, if any, still takes precedence. |
| Every read fails promptly | Reads begin at approximately t=0, 2, 7, 17s; then stop with the recovery action visible. Network time is additional. |
| Hide/offline before a scheduled wake-up | Cancel the timer. Resume with a fresh bounded cycle on return/reconnect; no background polling for hidden bots. |
| A different operation succeeds during an older confirmation read | The older response cannot clear the newer operation's receipt; the newer cycle starts after that in-flight read settles. |

The original three corrections remain: only submitted fields are overlaid; full-snapshot/event ordering is unchanged; exact pending identity plus intent must persist before writes; uncertain operations require explicit same-ID retry. The scheduler never calls that uncertain-write retry. Draft stores and bot/native settings code are unchanged. Shell generation **37** is retained from the still-unshipped parent.

For this liveness follow-up, source/code-path review, `npx tsc --noEmit`, scoped ESLint on the two changed TS/TSX files, `npm run build`, and `git diff --check` passed. **No automated tests or diagnostics were added or run**, and no new browser/timing/Safari verification is claimed. Earlier screenshots and executable diagnostic results below are evidence for `af997cd`, not measured validation of this scheduler. The existing snapshot RPC may take up to its 125-second timeout; retries are bounded in count, not a 17-second total network deadline. The error is visible after the first failed read, including while later reads are pending. The UI cannot know an external setting while the server is unreachable; it keeps the saved receipt visibly qualified until authoritative reconciliation succeeds.

## Earlier af997cd verification and limits

Commands actually run successfully for the original three corrections (not rerun for the liveness follow-up):

```sh
node diagnostics/bot-settings-review.mjs
npx tsc --noEmit
npx eslint app/bots/client.ts app/bots/composer-settings-controller.ts app/bots/composer-settings.tsx public/sw.js diagnostics/bot-settings-review.mjs
npm run build
git diff --check
```

The first command is the focused, reproducible diagnostic for these review findings. No app/bridge-wide automated suites were run. Build emitted vinext's existing route-classification informational note and completed successfully.

Physical Safari, real native acknowledgement latency and deployed shell replacement remain unverified. A genuinely uncertain native `bots.update` that has no terminal server operation result remains blocked: the bridge cannot establish exact operation completion from current settings alone. Same-ID retry does not blindly replay it. Storage failure can keep latest intent only in the current tab until storage recovers; the UI explicitly says to keep that tab open, and sends nothing new before persistence succeeds. Independent re-review is required before the manager's release.
