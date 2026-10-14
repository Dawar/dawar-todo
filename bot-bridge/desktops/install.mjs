/** Install the reviewed user-only helpers. Does not stop running desktops. */
import {
  mkdir,
  readFile,
  writeFile,
  copyFile,
  chmod,
  rename,
} from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
const source = fileURLToPath(new URL(".", import.meta.url)),
  home = homedir();
export async function installDesktops() {
  if (process.getuid?.() === 0)
    throw new Error("Install as the desktop user, never root.");
  for (const command of [
    "Xvnc",
    "tigervncpasswd",
    "xauth",
    "xfce4-session",
    "/usr/sbin/xrdp",
    "wmctrl",
    "xdpyinfo",
    "dbus-run-session",
  ])
    execFileSync("/bin/sh", ["-c", 'command -v "$1"', "check", command], {
      stdio: "ignore",
    });
  const base = join(home, ".local/share/codex-bot-desktops"),
    bin = join(home, ".local/bin"),
    units = join(home, ".config/systemd/user");
  await mkdir(base, { recursive: true, mode: 0o700 });
  await mkdir(bin, { recursive: true });
  await mkdir(units, { recursive: true });
  execFileSync("/usr/bin/python3", ["-c", "from gi.repository import Gio, GLib"], { stdio: "ignore" });
  const sync = join(home, ".local/share/codex-desktop-sync");
  await mkdir(sync, { recursive: true, mode: 0o700 });
  for (const file of ["sync.py", "app.py", "browser.py"]) {
    await copyFile(join(source, file), join(sync, file));
    await chmod(join(sync, file), 0o700);
  }
  for (const [command, file] of [["codex-desktop-sync", "sync.py"], ["codex-desktop-app", "app.py"]]) {
    await writeFile(join(bin, command), `#!/bin/sh\nexec /usr/bin/python3 "${join(sync, file)}" "$@"\n`, { mode: 0o700 });
    await chmod(join(bin, command), 0o700);
  }
  await mkdir(join(units, "bot-desktop@.service.d"), { recursive: true });
  await writeFile(join(units, "bot-desktop@.service.d/layout-sync.conf"), `[Service]\nExecStartPre=${bin}/codex-desktop-sync --profile %i --offline\n`);
  await writeFile(join(units, "codex-desktop-sync.service"), `[Unit]\nDescription=Sync primary XFCE dock and shortcuts to bot desktops\nAfter=default.target\n\n[Service]\nType=simple\nExecStart=${bin}/codex-desktop-sync --watch\nRestart=on-failure\nRestartSec=5\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`);
  await copyFile(join(source, "browser.py"), join(base, "browser.py.new"));
  await chmod(join(base, "browser.py.new"), 0o700);
  await rename(join(base, "browser.py.new"), join(base, "browser.py"));
  await copyFile(join(source, "manager.py"), join(base, "manager.py.new"));
  await chmod(join(base, "manager.py.new"), 0o700);
  await rename(join(base, "manager.py.new"), join(base, "manager.py"));
  await writeFile(
    join(bin, "codex-bot-desktop.new"),
    `#!/bin/sh\nexec /usr/bin/python3 "${join(base, "manager.py")}" "$@"\n`,
    { mode: 0o700 },
  );
  await chmod(join(bin, "codex-bot-desktop.new"), 0o700);
  await rename(
    join(bin, "codex-bot-desktop.new"),
    join(bin, "codex-bot-desktop"),
  );
  await writeFile(
    join(units, "bot-desktop@.service"),
    `[Unit]\nDescription=Persistent XFCE desktop for bot %i\nAfter=default.target\n\n[Service]\nType=simple\nExecStart=${bin}/codex-bot-desktop supervise %i\nRestart=on-failure\nRestartSec=3\nTimeoutStopSec=12\nKillMode=control-group\n\n[Install]\nWantedBy=default.target\n`,
  );
  await writeFile(
    join(units, "bot-rdp@.service"),
    `[Unit]\nDescription=Named RDP route for bot %i\nAfter=bot-desktop@%i.service\nRequires=bot-desktop@%i.service\n\n[Service]\nType=simple\nExecStart=/usr/sbin/xrdp --nodaemon --config ${base}/%i/xrdp.ini\nRestart=on-failure\nRestartSec=3\nTimeoutStopSec=12\nKillMode=control-group\n\n[Install]\nWantedBy=default.target\n`,
  );
  const skill = join(home, ".codex/skills/bot-desktop-computer-use");
  await mkdir(skill, { recursive: true });
  await writeFile(
    join(skill, "SKILL.md"),
    await readFile(join(source, "skill/SKILL.md")),
    { mode: 0o600 },
  );
  execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
  execFileSync("systemctl", ["--user", "enable", "--now", "codex-desktop-sync.service"], { stdio: "inherit" });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await installDesktops();
