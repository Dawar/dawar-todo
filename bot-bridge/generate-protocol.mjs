import { execFileSync } from "node:child_process";
import { CODEX_VERSION, codexBinary } from "./codex-version.mjs";
const binary = codexBinary();
if (
  execFileSync(binary, ["--version"], { encoding: "utf8" }).trim() !==
  `codex-cli ${CODEX_VERSION}`
)
  throw new Error(`Bindings must match the pinned Codex ${CODEX_VERSION}.`);
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
