---
name: bot-desktop-computer-use
description: Observe and control this DawarTodo bot's own persistent XFCE desktop with the bot_desktop MCP tools.
---

# This bot's desktop

Use `bot_desktop` for native applications and GUI workflows. A standalone Codex session may instead expose a dedicated `bot_desktop_*` server explicitly assigned to this bot; use that assigned server. If no assigned server is available, report the missing setup. Prefer a direct API or CLI when it fulfills the task. The server binds this session to this bot's stable identity; tools take no desktop selector. First use creates and starts the desktop. Idle desktops preserve open apps; browser disconnects leave apps running.

1. Call `screenshot`, inspect its image, pixel dimensions, active window and window IDs.
2. Act on observed coordinates with `click`, `double_click`, `drag` or `scroll`. For keyboard input use `type` (printable ASCII, up to 1,000 characters) or `keypress` (a key/chord). `window_focus` accepts an observed window ID; inspect another screenshot after focusing before typing. Supply `window_id` to guard actions where supported.
3. Call `screenshot` again and inspect the result. A screenshot from this connection within 60 seconds is required before input. Coordinates are original pixels, not preview dimensions.

The desktop uses the same Unix user and files but separate X11 authorization and XFCE settings. Do not select the human desktop or another bot's desktop to work around a failure. Apps with singleton processes may need a separate profile or a new instance; do not reuse another desktop's window.

The human and agent share control by default. Observe a fresh screenshot when the human may have changed focus or content. If the human chooses exclusive control, agent input is blocked while that lease is active; screenshots remain available. Wait for exclusive control to be released, then take a fresh screenshot before acting. Do not bypass the lease or X11 authorization. Dawar disabled the mouse-corner emergency stop for bot desktops: a pointer in a corner does not block input or require human movement. If an older connection reports a corner fail-safe, take a fresh screenshot to reconnect to the updated server; report a persistent error rather than repeatedly asking the human to move the pointer.

Stopping the desktop closes apps. Archiving a bot stops its desktop and retains settings; restoring it allows lazy restart. Deleting desktop data removes only its managed desktop profile, never the bot's workspace or shared files. These lifecycle operations are human controls, not permission to close apps during ordinary work.

## Browser memory and retention

Chrome uses this desktop's isolated profile. Balanced Memory Saver is seeded while Chrome is stopped and at future launches; a running profile is never edited externally. Preserve cookies, sign-ins and active/review tabs. Close tabs created for a completed task when they are no longer needed. Do not close a tab with unfinished forms, uploads, sign-in, payment, downloads or work awaiting review.

Use `browser_status` to read your own policy. The owner's sidebar choices are **Preserve browser** (default), **Close when safe after 60 minutes**, and **Keep open for current task**. Selecting the timeout alone does not release existing tabs.

- Call `browser_protect` with a stable `operation_id` when retaining unfinished work or review pages. This revokes an earlier release.
- Only after saving and completing all browser work, call `browser_release` with `safe_to_close=true` and a stable `operation_id`. This designates the current browser instance safe; it does not close it immediately or override Preserve. A release ends Keep open for current task and resumes the prior owner setting (Preserve if no timeout was selected). Reuse the ID on retries.
- New native work, agent desktop input or opening the human desktop viewer revokes release. Human input, RDP/VNC connections, unknown ownership/activity, action locks and exclusive leases also prevent cleanup. Preview screenshots alone are not activity.
- In the timeout mode, cleanup waits at least 60 minutes after release and actual desktop input, requires confirmed native idle and no unfinished/protected workflow, and sends one graceful close request. Save prompts/refusals remain open; no force killing. The desktop and profile stay intact.
- To reopen, take your own screenshot, call `browser_reopen` with a stable `operation_id`, then inspect a new screenshot. It uses your assigned launcher and tab restoration. **Unsaved form/page state is not guaranteed to restore.** Never relaunch another profile or the primary browser.

If these tools are not loaded yet, retain the browser and report that activation is pending; do not simulate release by killing Chrome.
