# Bot Plan/Fast responsiveness, v140 follow-up

Base: `af1837204eacf8930462c0c9e7ecd3305a3b9f6d` (released v140), isolated branch `codex/bot-typing-recent-3d829950`. The branch was clean before syncing; its previous two commits were already present on main as reviewed cherry-picks. No real bot settings or messages were changed.

## Cause, evidence, and fix

The v140 component put a synchronous lock around the first `bots.update` and disabled Plan, Fast, model and effort for the entire asynchronous RPC. It optimistically changed only the first tap, but the disabled CSS faded that pressed state. A second tap was discarded while the bridge awaited native `thread/settings/update`; its eventual acknowledgement could therefore apply a choice the person had already tried to reverse. This is a confirmed source path and was reproduced with delayed synthetic RPC responses. The production journal since the 17:20 UTC release had seven service entries and **zero** `bots.update` or `thread/settings/update` timing entries, so the actual iPhone/native latency cannot be inferred from logs. The client RPC timeout is 125 seconds, but that is a limit, not a measured request duration.

`ComposerSettingsController` now keeps owner/bot-scoped desired settings apart from the acknowledged state. Every tap updates the visible pressed state synchronously, including rapid reversals. It sends at most one settings mutation at a time, then coalesces the latest desired fields into the next ordered operation. A response never replaces a newer local choice. Each in-flight operation has a stable ID and exact parameters. Pending intent and its operation ID are written synchronously to owner-scoped localStorage; after a reload, an in-flight save becomes **unconfirmed**, requiring a read-only Check or explicit same-ID retry before another mutation. Bot navigation does not discard queued intent. Uncertain outcomes also hold the queue for reconciliation rather than sending a different operation blindly.

The bridge's operation wrapper incorrectly labelled even an explicit native settings rejection as `uncertain`. Settings-only `bots.update` now marks an explicit native/validation rejection as `rejected`, permitting a visible rollback. A transport loss or later storage failure stays uncertain. The bridge still awaits native settings acknowledgement before saving bot configuration, and native queue starts inherit settings only if they begin after that acknowledgement. The UI retains that precise future-turn wording; a turn already started cannot be changed retroactively.

## Direct diagnostics

On the actual workspace rendered in local Chromium with synthetic bots and held RPC replies, the sequence was:

| Moment | Plan | Fast | `bots.update` requests |
|---|---|---|---|
| Initial | off | off | 0 |
| Tap Plan | on immediately | off | 1: `{mode:"plan"}` |
| Tap Plan again before reply | off immediately | off | still 1 |
| Tap Fast before reply | off | on immediately | still 1 |
| First acknowledgement | off | on | 2: `{serviceTier:"fast",mode:"default"}` |
| Second acknowledgement | off | on | 2 total |

Both toggles remained enabled during saving. Switching to another bot before the first reply still dispatched the queued reversal for the original bot; returning showed the latest choice. A definite rejection with a queued reversal left Plan off, sent no later mutation and showed the native error. A synthetic fresh-process reconstruction retained the same in-flight operation ID, displayed the latest off choice, and required confirmation before continuing. These are browser and in-memory synthetic results, not user-account or iPhone measurements.

A temporary SQLite/Codex-stub calculation made two concurrent bot updates. Before the first acknowledgement there was **one** native settings call and the stored mode remained default; after it, the second native call carried default, and after both, the stored mode was default. An explicit native rejection returned `outcome:"rejected"` and left stored mode unchanged. No automated test suites were added or run.

After the change, rendered widths were 320/390/1440px with matching body widths, 54/54/48px settings rows, 40/40/34px Plan/Fast targets and a 40px input. The pending 390px capture shows a strong pressed state and a small, visible Saving badge. Local captures: `outputs/bot-typing-recent/composer-v140-pending-390.png`, `composer-v140-final-320.png`, `composer-v140-final-390.png`, `composer-v140-final-desktop.png`. Those ignored files are disposable. Physical Safari and native live-setting timing remain unverified.

`npx tsc --noEmit`, scoped ESLint, `npm run build`, and `git diff --check` passed. The bridge change needs a manager-coordinated service reload after integration. No merge, push, restart or deployment was performed here.
