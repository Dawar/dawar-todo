# Bot browser memory policies

## Scope and installation

Bot Chrome data lives in `~/.local/share/codex-bot-desktops/<profile>/config/google-chrome`. The primary `~/.config/google-chrome` is excluded. `node bot-bridge/desktops/install.mjs` installs the user helpers and skill without restarting desktops or the bridge:

- `~/.local/share/codex-bot-desktops/{manager.py,browser.py}`
- `~/.local/share/codex-desktop-sync/{app.py,browser.py,sync.py}`
- `~/.local/bin/codex-desktop-app` and `codex-bot-desktop`
- `~/.codex/skills/bot-desktop-computer-use/SKILL.md`

The launcher and desktop supervisor seed **balanced Chrome Memory Saver** only when the assigned browser is stopped, under `browser-launch.lock`. Existing live Chrome preferences are read only and deferred to the next normal launch. Profile-local `Local State` keys are `performance_tuning.high_efficiency_mode.state=2` and `aggressiveness=1`. Their definitions are in [Chromium prefs.h](https://chromium.googlesource.com/chromium/src/+/main/components/performance_manager/public/user_tuning/prefs.h) and [prefs.cc](https://chromium.googlesource.com/chromium/src/+/main/components/performance_manager/user_tuning/prefs.cc). No enterprise policy or primary settings change. Before replacement, a private backup is saved in `<profile>/browser-preference-backups/`; cookies, login/session files and extensions are not rewritten.

The existing OVH swap buffer already satisfies the approved 8–16 GiB requirement: `/swapfile`, 17,179,869,184 bytes, root:root mode600; `/etc/fstab` contains `/swapfile none swap sw 0 0`; `/etc/sysctl.d/90-codex-memory.conf` sets `vm.swappiness=10`. Reuse it; do not allocate a duplicate buffer. This machine has 64GB physical RAM (about62GiB usable), superseding the original32GB/no-swap context.

## Retention contract

Each stable bot ID has a `browserRetention` record in the existing private bridge SQLite store, bound to its hashed/adopted profile name. Missing records mean **Preserve**, protected, no release. The sidebar offers:

- **Preserve browser**: no automatic closure.
- **Close when safe after60minutes**: requires an explicit release of saved, completed browser work; selecting the option does not release existing tabs.
- **Keep open for current task**: protect until the agent completes and releases the task; then resume the prior owner choice (Preserve by default).

Policy changes use authenticated `desktop.browserPolicy` RPC with `expectedRevision` and the existing stable operation receipt/fingerprint ledger. There is no arbitrary profile selector. Each successful update increases a revision. A stale revision rejects; same completed operation ID replays its receipt, an uncertain in-flight outcome is not blindly retried under a new ID.

Assigned MCP tools add `browser_status`, `browser_protect`, `browser_release(safe_to_close=true)` and `browser_reopen`. Mutations require a stable `operation_id` and use that same ledger/owner bot lock. Release captures the current activity token **before** the awaited process probe and checks it after; any new native activity/unresolved state rejects the stale release. It binds the exact current browser root PID/starttime, boot ID, thread, timestamp and actual-input monotonic boundary. Protect is always conservative. New native dispatch/observed activity revokes release without altering existing native generation/status/receipt authority. Agent desktop input and human viewer opening also revoke it.

Implicit protection on desktop input or viewer opening always cancels pending browser maintenance and validates ownership/policy. If the policy is already protected with no release, it leaves the revision unchanged; otherwise it revokes release and advances the revision. Explicit `browser_protect` remains a durable mutation with its original receipt behavior. This allows an owner to use the retention selector from the same bot desktop without its own input invalidating the selector's revision. Stale or concurrent actual policy changes still reject. Passive preview responses cannot replace a newer browser revision or clear a policy-saving error.

The manager's once-per-minute timer only considers opted-in, released profiles. Preview screenshots do not refresh activity. All of these are required:

1. Release at least60minutes old, profile/thread/revision and exact browser instance unchanged.
2. No active/unresolved primary, retained worker or lane work, pending input, uncertain native submission/scheduled work. A fresh bounded `thread/read(includeTurns=false)` reports the exact thread **idle**; its activity generation stays unchanged.
3. No viewer/ticket, RDP or VNC connection. Native shared human/agent control remains supported; cleanup waits until both finish.
4. XScreenSaver reports at least60minutes since actual input. Input after the release boundary invalidates eligibility; screenshots are passive.
5. No exclusive lease, no input/action lock conflict, no uncertain ownership or missing activity data.

Maintenance never holds the bot admission or desktop coordinator lock across a native read or OS wait. Exact-thread idle reads have an explicit2second deadline. Send/Stop, any real bot admission, new native activity, policy/protection changes and viewer/input requests cancel the disposable helper before their own admission; delayed metadata cannot block them. Timeout or stale pre-attempt reads leave the release unchanged and grant no close permission.

After native and OS preparation, one synchronous local revision check consumes the release before any possible close effect. The nonblocking helper uses a bounded per-window protocol: native idle read (outside admission locks), OS preparation under `action.lock`, then a synchronous bridge activity/revision/lock/viewer recheck and a200ms close permit. The native idle observation must be at most1second old at permission issuance. The helper immediately rechecks process/boot/input/connection/lease and exact window PID under that deadline, then sends `_NET_CLOSE_WINDOW` directly through X11. No delayed `wmctrl` subprocess can issue an abandoned request. At most8windows/12seconds total, with2.5second permit waits and2second OS subprocess bounds; all shared bridge notifications/heartbeats/other-bot admission continue during waits. Cancellation terminates only the disposable helper, never Chrome. Every window requires a new native read and permit; unknown or partial protocol state defers.

This is observational concurrency control, not a transaction with the external native server/X server. Activity not yet reported by the native server, direct RDP input, and requests arriving between the final check and X11 event delivery have a residual race. Cancellation cannot retract an already delivered close request. The200ms permit and final OS checks bound the request path; they cannot promise an absolute atomic human/native/OS snapshot. If preparation is too slow for freshness/deadline, retain the browser. Save prompts/refusals remain open; no forced quit, prompt dismissal or automatic retry. Any consumed attempt, including a cancellation or partial window close, requires explicit review/release again. The desktop is never stopped.

Reopening uses the assigned launcher with `--restore-last-session` in a separate transient user service `bot-browser-<profile>-<identity>.service`, outside the bridge cgroup. It requires a fresh own screenshot and honors the action lock/exclusive lease. Inspect a screenshot afterward. **Unsaved form/page state is not guaranteed to restore.** Browser profiles/sign-ins remain independent; dock/layout synchronization is unchanged.

## Rollout and verification limits

Install machine helpers/skill first. The bridge tools/timer/RPC and sidebar need the reviewed exact source activation and frontend release. Keep initial existing sessions Preserve. Never restart the central bridge while native work is active; production release owner coordinates the one exact idle guard and existing publication gates.

Manual Linus evidence is separate from public sidebar/MCP activation evidence. Do not age release timestamps, inject fake activity or claim a full60-minute close was observed from a recent-input refusal. No automated suites are part of this pass. One live bot profile may remain pending until its ordinary launch; never operate another bot's GUI or force close its browser to apply settings.

## Proposed heavy-build follow-up (not applied)

Move a heavy build invocation into its own transient **user systemd service**, outside `dawar-todo-bots.service`. For example, after owner/developer agreement:

```sh
systemd-run --user --collect --wait --pipe \
  --unit=project-build-UNIQUE-ID --working-directory=/path/to/project \
  --property=MemoryHigh=6G --property=MemoryMax=8G \
  --property=MemorySwapMax=2G --property=CPUWeight=50 \
  --property=IOWeight=50 --property=TasksMax=256 \
  --property=OOMPolicy=stop EXISTING-BUILD-COMMAND
```

Use a stable job identity, capture exit/log/resource receipt and retain artifacts. Confirm cgroup-v2 delegation/controller support and actual representative peak usage before selecting limits. A build can still fail at its limit, but its OOM stop applies to its own service. Optionally propose an aggregate build slice later, with limits chosen for64GB. The bridge's current `OOMPolicy=stop` remains unchanged. **No Angular command/concurrency changes were made**; Dawar deferred that decision. No RAM purchase or unrelated system policy is included.
