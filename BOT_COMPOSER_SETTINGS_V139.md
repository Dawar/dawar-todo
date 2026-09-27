# Bot composer settings and bottom bar, v139 follow-up

Base: `8538e9689da0f3aede0469f8860b620231e3aa42` on `codex/bots`. Isolated branch: `codex/bot-typing-recent-3d829950`. The live `/bots` route redirects unauthenticated requests to sign-in, so no user account or deployed conversation was opened. The local preview renders the actual workspace, composer and CSS against synthetic bots.

## Cause and change

- **Confirmed in source:** Plan and Fast read the last bot snapshot. Their old handlers called a shared asynchronous `action()` without disabling either control, so rapid taps could send repeated stale values. An error appeared in the header, far from the controls. The Fast indication also compared against the first catalog tier, which could disagree with an effective `priority`/`fast` value.
- **Confirmed in source:** `runtime.update()` waited for native `thread/settings/update` before saving the bot. A native rejection prevented either preference from persisting. Whether the native 0.156.1 call actually rejects during a live turn was not probed against the production service. The local Codex stub explicitly rejects it in that state and demonstrates the old causal path. A live `turn/steer` has no mode/tier fields; the current turn keeps its settings. `startTurn` passes stored settings to the next interactive turn, and `startQueued` syncs thread settings before its queued start.
- **Implemented:** An active turn's Plan/Fast/model/effort choices are saved as next-turn bot configuration without attempting to change that active native turn. Idle changes still await a successful native settings update before saving. The extracted `ComposerSettings` serializes requests per bot, shows a tentative pending state, uses the returned bot as confirmation, refreshes a missed snapshot, and puts errors beside the controls. An uncertain acknowledgement locks further changes until Check setting or an explicit same-operation-ID retry reconciles it; a definite rejection restores the prior state. Model changes choose a supported effort and reset an incompatible Fast tier. Both native tier IDs, `priority` and `fast`, display as Fast.
- **Visual:** The bottom controls use a single aligned row with compact model/effort selects and distinct Plan/Fast pressed states. Desktop keeps the meaning of active-turn changes visible as “Next turn”; mobile spells out that the current run keeps its settings. The settings row has a stable footprint while saving. Attachment, queue, send, stop, composer input, and durable draft code are unchanged.

## Focused evidence

Direct runtime module calculation using a temporary synthetic SQLite store and Codex stub: while a turn is active, updating to Plan and standard tier persisted both fields with **zero** native setting calls. After ending the synthetic turn, changing back invoked **one** native settings call with `mode=default`, `serviceTier=priority`, and persisted the result. This exercises runtime configuration, not a user bot or native Codex process.

Local Chromium rendered inspection used the real workspace with a synthetic transport. Two rapid taps during one pending Fast change yielded **one** `bots.update`; Plan and Fast were disabled pending acknowledgement, with a 40px editor. Acceptance persisted `serviceTier=default` and displayed Fast off. A rejected Plan update left `mode=default`, restored its off state and showed the native error beside the controls. An uncertain Plan response kept Plan unconfirmed and disabled; Check setting made no second mutation, and Try again used the **same operation ID** twice before confirming `mode=plan`.

| Viewport | Body width | Settings row | Plan/Fast target | Composer input | Result |
|---|---:|---:|---:|---:|---|
| 320×740 | 320px | 54px | 40px each | 40px | Full model name visible; no horizontal overflow |
| 390×844 | 390px | 54px | 40px each | 40px | Controls grouped, no horizontal overflow |
| 1440×1000 | 1440px | 48px | 34px mouse targets | 40px | Controls aligned to the 860px conversation column |
| Simulated 320px keyboard, visual viewport 330px | 320px | 48px | 38px each | Bottom 320px | Input remains inside visual viewport |

Screens personally inspected: `outputs/bot-typing-recent/composer-final2-320.png`, `composer-final2-390.png`, `composer-final2-1440.png`, `composer-keyboard-final-320.png`, `composer-next-turn-390.png`, `composer-pending-390.png`, `composer-error-390.png`, and `composer-uncertain-390.png`. Those ignored output files are disposable. The last final-width captures preceded only a one-line legacy Fast disable correction, which does not change layout. No physical iPhone/Safari measurements are claimed.

TypeScript, scoped ESLint, `npm run build`, and `git diff --check` were run. No automated test suite was added or run. The bridge runtime change requires a manager-coordinated service reload after integration; this worker made no production change. Native queue auto-dispatch may race a deferred active-turn setting; explicit `startQueued` synchronizes before dispatch, but native autonomous dispatch timing was not measured. Production verification of that race would require a supervised service probe, not a claim from the synthetic fixture.
