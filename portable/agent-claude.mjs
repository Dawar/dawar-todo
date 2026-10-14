import { join } from 'node:path';
import { ClaudeBackend } from '../bot-bridge/claude.mjs';

// Claude bots stay off unless explicitly enabled. Portable releases do not
// ship the ~230 MB native Claude Code package (release bound: 256 MB), so the
// executable is a local binary pinned by SHA-256, exactly like Codex. A bad
// configuration only fails the Claude backend's start; Codex bots still run.
export function portableClaude(store, dataDirectory, env = process.env) {
  if (env.BOTS_CLAUDE_ENABLED !== '1') return null;
  return new ClaudeBackend({
    store,
    configDir: join(dataDirectory, 'claude'),
    executable: env.BOTS_CLAUDE_BINARY ?? '',
    executableSHA256: env.BOTS_CLAUDE_BINARY_SHA256 ?? null,
  });
}
