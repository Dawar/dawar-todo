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

The human and agent share control by default. Observe a fresh screenshot when the human may have changed focus or content. If the human chooses exclusive control, agent input is blocked while that lease is active; screenshots remain available. Wait for exclusive control to be released, then take a fresh screenshot before acting. Do not bypass the lease, X11 authorization, or PyAutoGUI fail-safe. If the pointer is in a reserved screen corner, ask the human to move it.

Stopping the desktop closes apps. Archiving a bot stops its desktop and retains settings; restoring it allows lazy restart. Deleting desktop data removes only its managed desktop profile, never the bot's workspace or shared files. These lifecycle operations are human controls, not permission to close apps during ordinary work.
