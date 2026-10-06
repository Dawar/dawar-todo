import { homedir } from "node:os";
import { join } from "node:path";

// Update this one pin together with generated protocol types. Installing a new
// CLI does not replace a running bot process or silently change its contract.
export const CODEX_VERSION = "0.160.1";
export const CODEX_PACKAGE = "app-server-daemon";
export const codexBinary = () => process.env.BOTS_CODEX_BINARY ?? join(
  homedir(), `.codex/packages/${CODEX_PACKAGE}/releases/${CODEX_VERSION}-x86_64-unknown-linux-musl/bin/codex`,
);
