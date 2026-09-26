import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
const binary =
  process.env.BOTS_CODEX_BINARY ??
  join(
    homedir(),
    ".codex/packages/standalone/releases/0.156.1-x86_64-unknown-linux-musl/bin/codex",
  );
if (
  execFileSync(binary, ["--version"], { encoding: "utf8" }).trim() !==
  "codex-cli 0.156.1"
)
  throw new Error("Bindings must match the pinned Codex 0.156.1.");
execFileSync(
  binary,
  [
    "app-server",
    "generate-ts",
    "--experimental",
    "--out",
    "lib/codex-protocol",
  ],
  { stdio: "inherit" },
);
