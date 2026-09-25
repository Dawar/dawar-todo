import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
const root = resolve(fileURLToPath(new URL("..", import.meta.url))),
  home = homedir(),
  config = join(home, ".config/dawar-todo-bots/environment");
await access(config).catch(() => {
  throw new Error(
    `Configure ${config} using bot-bridge/environment.example first.`,
  );
});
const service = await readFile(
  new URL("./dawar-todo-bots.service", import.meta.url),
  "utf8",
);
const unit = service
  .replace(
    "WorkingDirectory=/home/dawar/ChatGPT/dawar-todo",
    `WorkingDirectory=${root}`,
  )
  .replace(
    "ExecStart=/usr/bin/env node /home/dawar/ChatGPT/dawar-todo/bot-bridge/service.mjs",
    `ExecStart="${process.execPath}" "${join(root, "bot-bridge/service.mjs")}"`,
  );
const unitDir = join(home, ".config/systemd/user");
await mkdir(unitDir, { recursive: true });
await writeFile(join(unitDir, "dawar-todo-bots.service"), unit);
for (const args of [
  ["--user", "daemon-reload"],
  ["--user", "enable", "--now", "dawar-todo-bots.service"],
])
  execFileSync("systemctl", args, { stdio: "inherit" });
console.log(
  "Service installed. Check: systemctl --user status dawar-todo-bots; curl http://127.0.0.1:47821/healthz",
);
console.log(
  "For boot and logout persistence enable lingering: loginctl enable-linger " +
    process.env.USER,
);
