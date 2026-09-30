# Persistent bot desktops

Every bot receives `bot_desktop` MCP configuration on native thread creation or resume. Tools are authenticated to its stable bot ID through the private manager socket. Listing tools does not create a desktop. The first screenshot, or the human opening the viewer, provisions and starts a dedicated XFCE/Xvnc session as the service's Unix user.

## Ownership and lifecycle

- Names are derived from the bot ID. Allocation is protected by an interprocess lock; the private `config.json` records the owner, X11 display and ports.
- Each desktop has separate Xauthority, D-Bus, XFCE configuration/cache/data, credentials and user services. The home and filesystem are shared; this is session separation, not a security sandbox.
- Idle bots and closed browser viewers preserve open apps. Enabled desktops also start after reboot when user lingering is enabled.
- Stop closes apps and disables both user units. First use starts them again.
- Archive stops the desktop and retains its profile. Restore permits lazy restart.
- Delete requires an archived, settled bot, records a durable receipt, removes only its owned desktop profile and hides the bot. Its workspace and native history remain. Recovery reconciles the original deletion receipt without a new operation ID.
- Runtime recovery enforces archived/deleted state without eagerly starting unused desktops.

## Tools and human collaboration

The eight tools are screenshot, click, double_click, drag, scroll, type, keypress and window_focus. Screenshots use MSS; input uses PyAutoGUI. The server requires an observation from its MCP connection within 60 seconds before input, validates coordinates/window IDs and preserves the PyAutoGUI fail-safe. The sidebar's smaller preview does not satisfy this observation requirement.

Shared human/agent control is the default. The viewer's optional **Take exclusive control** acquires a 30-second lease, renewed by its heartbeat, which blocks agent input while allowing screenshots and other work. Closing/disconnecting releases the lease; expiry recovers after a dropped connection. Other browser viewers must close before exclusive control can be acquired. Direct RDP shares the desktop but does not acquire a browser control lease.

The assigned skill is installed at `~/.codex/skills/bot-desktop-computer-use/SKILL.md`. New profiles and every turn's current profile context describe the assigned desktop. Native bot sessions disable the inherited human `linux_computer_use` and legacy `bot_desktop_linus` entries; they use the bot-bound MCP instead. No global Codex configuration edits are required.

## Browser transport

The selected bot's sidebar card captures only while visible and online, at most once every five seconds. JPEG previews are resized to 480 pixels and briefly cached in VM memory. Opening it creates a fullscreen noVNC dialog; the desktop retains its original resolution while the viewer scales it.

Both browser and VM connect outward through the existing authenticated Bots relay. A separate browser socket consumes a one-use, 30-second desktop ticket bound to its parent browser connection and bot. Raw VNC traffic goes only to that socket; desktop passwords/tickets are ephemeral and excluded from SQLite receipts, normal event broadcasts and logs. Parent disconnection, sign-out, ticket expiry or VM disconnection closes the stream. The viewer renews its owner authentication during long sessions. VNC remains loopback-only. No public VNC or noVNC service is added.

Limits: eight live viewers, 32 pending tickets, bounded binary/JSON frames and buffers. Browser keyboard, mouse, mobile key buttons and clipboard paste are supported. Application clipboard compatibility and mobile layouts still need production device review.

## Installation and existing desktop adoption

Run as the desktop user, never root. Prerequisites on this host already include TigerVNC, XFCE, xrdp, wmctrl, xauth, xdpyinfo, D-Bus and the existing PyAutoGUI/MSS Python environment/launcher.

`node bot-bridge/desktops/install.mjs` installs the user helper, service templates and skill without restarting running desktops. The main `npm run bots:install` includes this step, then installs/starts the bridge; run it only during an approved, idle production rollout.

New RDP routes bind to loopback by default. To make them reachable through this host's existing Tailscale network, set this in the private bridge environment file before provisioning:

```ini
BOTS_DESKTOP_RDP_BIND=100.87.162.94
BOTS_DESKTOP_ADOPT={"linus-computer-admin":"linus"}
```

The explicit adoption map preserves Linus's existing `:20` desktop/port `3390`; adoption refuses a different owner. These settings do not change an already configured desktop's bind or ports. Human RDP `3389`/Xorg `:10` remain separate.

Installed paths:

- `~/.local/bin/codex-bot-desktop` (regular wrapper)
- `~/.local/share/codex-bot-desktops/manager.py`
- `~/.local/share/codex-bot-desktops/<name>/` (private profile and credentials)
- `~/.config/systemd/user/bot-desktop@.service`, `bot-rdp@.service`
- `~/.codex/skills/bot-desktop-computer-use/SKILL.md`

The live bridge runs the reviewed Python MCP/capture sources from its deployed `bot-bridge/desktops/` directory through `~/.local/bin/codex-linux-computer-use`, supplying the named desktop's exact X11 authorization. Treat the deployed checkout as a persistent service dependency.

## Rollout and checks

Deploy the updated application and Bots relay, apply the two private environment settings above, integrate the bridge code/dependencies and restart the bridge when bots are idle. Back up the bridge state and environment first; retain the bot workspaces and desktop profiles. Do not restart the human xrdp service or reset desktop sessions. Rollback can restore the previous bridge/app/relay release while retaining the desktop profiles and ownership metadata.

Local checks on 2026-09-30: application production build, TypeScript, targeted lint, Python compilation and relay deployment dry run passed. Real XFCE observations and reversible input worked through the new MCP. A disposable desktop was created lazily from the actual sidebar component; the actual noVNC dialog displayed it and accepted mouse/keyboard input. Shared mode was default; exclusive lease acquisition and release on viewer close were observed. The disposable desktop and review server were removed afterward. Human `:10` and Linus `:20` remained running; Linus health checks passed.

These checks used a loopback development bridge to exercise the actual UI and VM gateway. They do not establish production relay authorization behavior, owner-login end-to-end behavior, mobile layout or multi-bot load capacity. No production relay/app publication or bridge restart was performed during implementation review. Formal automated suites were not run.
