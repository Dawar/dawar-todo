import { EventEmitter } from "node:events";
import { spawn, execFileSync } from "node:child_process";
import { createInterface } from "node:readline";

export const CODEX_VERSION = "0.156.1";
export class Codex extends EventEmitter {
  constructor(binary) {
    super();
    this.binary = binary;
    this.pending = new Map();
    this.counter = 0;
    this.ready = false;
  }
  async start() {
    const version = execFileSync(this.binary, ["--version"], {
      encoding: "utf8",
    }).trim();
    if (version !== `codex-cli ${CODEX_VERSION}`)
      throw new Error(
        `Expected Codex ${CODEX_VERSION}; found ${version}. Regenerate and validate the protocol bindings before upgrading.`,
      );
    this.process = spawn(this.binary, ["app-server", "--stdio"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    // Protocol stdout must never be mixed with diagnostic logs.
    this.process.stderr.on("data", (chunk) => {
      if (process.env.BOTS_DEBUG === "1") process.stderr.write(chunk);
    });
    createInterface({ input: this.process.stdout }).on("line", (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.method)
        this.emit(
          message.id !== undefined ? "request" : "notification",
          message,
        );
      else if (this.pending.has(message.id)) {
        const p = this.pending.get(message.id);
        this.pending.delete(message.id);
        clearTimeout(p.timer);
        if (message.error) {
          const e = new Error(message.error.message);
          e.rpcCode = message.error.code;
          e.definite = true;
          p.reject(e);
        } else p.resolve(message.result);
      }
    });
    this.process.on("exit", (code) => {
      this.ready = false;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(
          new Error(
            "Codex disconnected; the operation outcome may be uncertain.",
          ),
        );
      }
      this.pending.clear();
      this.emit("disconnect", code);
    });
    this.process.on("error", (error) => this.emit("fault", error));
    await this.call("initialize", {
      clientInfo: {
        name: "dawar_todo_bots",
        title: "Dawar Todo Bots",
        version: "1.0.0",
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        mcpServerOpenaiFormElicitation: true,
      },
    });
    this.write({ method: "initialized", params: {} });
    this.ready = true;
  }
  write(message) {
    if (!this.process?.stdin.writable)
      throw new Error("Codex is disconnected.");
    this.process.stdin.write(JSON.stringify(message) + "\n");
  }
  call(method, params = {}) {
    const id = ++this.counter;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `Codex ${method} timed out; check the conversation before retrying.`,
          ),
        );
      }, 120000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ id, method, params });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }
  respond(id, result) {
    this.write({ id, result });
  }
  reject(id, message) {
    this.write({ id, error: { code: -32601, message } });
  }
  close() {
    this.process?.kill("SIGTERM");
  }
}
