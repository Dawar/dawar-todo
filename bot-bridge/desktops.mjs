import { spawn, execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import { createHash, randomBytes } from "node:crypto";
import { readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { connect } from "node:net";
import sharp from "sharp";
import { captureActivity, activityUnchanged } from "./turn-state.mjs";

const exec = promisify(execFile);
const noBrowserEffect = message => Object.assign(Error(message), { browserNoEffect: true });
const resources = fileURLToPath(new URL("./desktops/", import.meta.url));
const object = (properties = {}, required = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const coord = { type: "integer", minimum: 0 },
  str = { type: "string" };
const window_id = { type: "string", pattern: "^0x[0-9a-fA-F]{1,8}$" };
const button = {
  type: "string",
  enum: ["left", "middle", "right"],
  default: "left",
};
const tool = (name, description, properties, required = []) => ({
  name,
  description,
  inputSchema: object(properties, required),
  annotations: {
    readOnlyHint: ["screenshot", "browser_status"].includes(name),
    destructiveHint: !["screenshot", "browser_status"].includes(name),
    openWorldHint: !["screenshot", "browser_status"].includes(name),
  },
});
export const DESKTOP_TOOLS = [
  tool("browser_status", "Read your assigned browser retention policy and Memory Saver status; no tab content is returned.", {}),
  tool("browser_release", "Explicitly designate your saved, finished browser workflow safe to close after 60 minutes if the owner opted in. Do not release ongoing, unfinished or review pages. Idempotent operation_id required.",
    { operation_id: str, safe_to_close: { type: "boolean", const: true } }, ["operation_id", "safe_to_close"]),
  tool("browser_protect", "Keep your browser open for unfinished work or review; revoke any prior safe-to-close release.",
    { operation_id: str }, ["operation_id"]),
  tool("browser_reopen", "Reopen only your assigned Chrome profile with tab restoration. A fresh own screenshot is required; verify afterward. Unsaved state is not guaranteed to restore.",
    { operation_id: str }, ["operation_id"]),
  tool(
    "screenshot",
    "Observe this bot's own desktop as PNG, with pixel dimensions and window IDs. First use starts it. Inspect before acting and again afterward.",
    {},
  ),
  tool(
    "click",
    "Click observed absolute coordinates on this bot's desktop.",
    { x: coord, y: coord, button, window_id },
    ["x", "y"],
  ),
  tool(
    "double_click",
    "Double-click observed absolute coordinates.",
    { x: coord, y: coord, button, window_id },
    ["x", "y"],
  ),
  tool(
    "drag",
    "Drag between observed coordinates; release the button on abort.",
    {
      start_x: coord,
      start_y: coord,
      end_x: coord,
      end_y: coord,
      duration: { type: "number", minimum: 0.1, maximum: 3 },
      button,
      window_id,
    },
    ["start_x", "start_y", "end_x", "end_y"],
  ),
  tool(
    "scroll",
    "Scroll at observed screen coordinates.",
    {
      clicks: { type: "integer", minimum: -20, maximum: 20 },
      x: coord,
      y: coord,
      window_id,
    },
    ["clicks", "x", "y"],
  ),
  tool(
    "type",
    "Type text into the observed active window.",
    {
      text: { type: "string", minLength: 1, maxLength: 1000 },
      interval: { type: "number", minimum: 0, maximum: 0.05 },
      window_id,
    },
    ["text"],
  ),
  tool(
    "keypress",
    "Press a key or chord in the observed active window.",
    {
      keys: { type: "array", items: str, minItems: 1, maxItems: 5 },
      window_id,
    },
    ["keys"],
  ),
  tool(
    "window_focus",
    "Focus an observed window ID. Screenshot again before typing.",
    { window_id },
    ["window_id"],
  ),
];
export const DESKTOP_INSTRUCTIONS =
  "For desktop UI tasks use your bot_desktop MCP and the bot-desktop-computer-use skill. It is bound to your own persistent desktop and starts on first screenshot. Observe before input and verify afterward. Shared human/agent control is the default. Honor the human's optional exclusive control lease. Never switch to the human or another bot desktop to bypass a failure. Close completed-task tabs while retaining ongoing work and review pages. Read browser_status; use browser_protect for unfinished workflows and browser_release only after saving and completing the browser work. Preserve is the default; cleanup requires explicit owner opt-in and a safe-to-close release.";

// Explicit owner configuration; neither bot names nor prompts grant this role.
export function canManagePrimaryDesktop(bot) {
  return Boolean(process.env.BOTS_PRIMARY_DESKTOP_BOT_ID && bot?.id === process.env.BOTS_PRIMARY_DESKTOP_BOT_ID);
}
export function desktopInstructions(bot) {
  return DESKTOP_INSTRUCTIONS + (canManagePrimaryDesktop(bot)
    ? " Dawar explicitly authorizes this computer-admin bot to manage BOTH its own bot desktop and the primary human desktop. For work specifically targeting the primary desktop use linux_computer_use and read the linux-computer-use skill; that MCP is pinned to :10.0. Continue using bot_desktop for your own work. Identify the intended desktop before observing or acting, honor the human's current activity, and never use either desktop to bypass a failure, exclusive control, or an authorization boundary. After primary dock or shortcut changes, run /home/dawar/.local/bin/codex-desktop-sync to propagate the shared layout."
    : "");
}

// A bounded, lazy MCP connection. Never initializes X11 while simply listing tools.
class ComputerClient {
  constructor(command, args, env) {
    this.id = 0;
    this.pending = new Map();
    this.child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stderr.on("data", () => {}); // X11 diagnostics can contain window titles.
    const fail = () => {
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(
          new Error("Desktop MCP disconnected; observe before retrying input."),
        );
      }
      this.pending.clear();
      this.dead = true;
    };
    this.child.on("error", fail);
    this.child.on("exit", fail);
    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", (line) => {
      if (line.length > 16 * 1024 * 1024) {
        this.close();
        return;
      }
      let m;
      try {
        m = JSON.parse(line);
      } catch {
        this.close();
        return;
      }
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.error) p.reject(new Error(m.error.message));
      else p.resolve(m.result);
    });
    this.ready = this.rpc("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "DawarTodo", version: "1" },
    }).then(() =>
      this.child.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized",
        }) + "\n",
      ),
    );
    this.ready.catch(() => {});
  }
  rpc(method, params) {
    if (this.dead) return Promise.reject(new Error("Desktop MCP is closed."));
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.close();
        reject(
          new Error(
            "Desktop action timed out; do not repeat input without observing.",
          ),
        );
      }, 70000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
      );
    });
  }
  async call(name, args) {
    await this.ready;
    return this.rpc("tools/call", { name, arguments: args });
  }
  close() {
    this.child.kill();
  }
}

export class BotDesktops {
  constructor({
    runtime,
    base = join(homedir(), ".local/share/codex-bot-desktops"),
    launcher = join(homedir(), ".local/bin/codex-linux-computer-use"),
    adopt = {},
  }) {
    Object.assign(this, { runtime, base, launcher, adopt });
    this.clients = new Map();
    this.observations = new Map();
    this.retentionBusy = false;
    this.retentionTimer = setInterval(() => void this.retentionTick().catch(() => {}), 60000);
    this.retentionTimer.unref();
    this.locks = new Map();
    this.previews = new Map();
    this.tickets = new Map();
    this.sessions = new Map();
    this.sweeper = setInterval(() => {
      for (const [id, s] of this.sessions)
        if (s.expiresAt <= Date.now())
          void this.end(id, "Desktop connection expired.").catch(() => {});
      for (const [token, t] of this.tickets)
        if (t.expiresAt <= Date.now()) this.tickets.delete(token);
    }, 5000);
    this.sweeper.unref();
  }
  name(bot) {
    return (
      this.adopt[bot.slug] ??
      `bot-${createHash("sha256").update(bot.id).digest("hex").slice(0, 24)}`
    );
  }
  assertBot(bot) {
    if (!bot || bot.archived || bot.archiving || bot.deletedAt)
      throw new Error("Restore this bot before using its desktop.");
  }
  async lock(bot, fn) {
    const previous = this.locks.get(bot.id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(fn);
    this.locks.set(bot.id, next);
    try {
      return await next;
    } finally {
      if (this.locks.get(bot.id) === next) this.locks.delete(bot.id);
    }
  }
  async command(bot, action, session) {
    const args = [join(resources, "manager.py"), action, this.name(bot)];
    if (
      [
        "ensure",
        "adopt",
        "remove",
        "lease-acquire",
        "lease-renew",
        "lease-release",
      ].includes(action)
    )
      args.push("--owner", bot.id);
    if (session) args.push("--session", session);
    return exec("/usr/bin/python3", args, {
      timeout: 40000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, BOTS_DESKTOP_DIR: this.base },
    });
  }
  async configured(bot) {
    const cfg = JSON.parse(
      await readFile(join(this.base, this.name(bot), "config.json"), "utf8"),
    );
    if (cfg.owner !== bot.id) throw new Error("Desktop ownership mismatch.");
    return cfg;
  }
  async ensure(bot) {
    this.assertBot(this.runtime.store.bot(bot.id));
    if (this.adopt[bot.slug]) await this.command(bot, "adopt");
    await this.command(bot, "ensure");
    return this.configured(bot);
  }
  async running(cfg) {
    return access(`/tmp/.X11-unix/X${cfg.display}`).then(
      () => true,
      () => false,
    );
  }
  async start(bot) {
    const cfg = await this.ensure(bot);
    await this.command(bot, "start");
    return cfg;
  }
  env(bot, cfg) {
    const directory = join(this.base, this.name(bot));
    return {
      ...process.env,
      CODEX_COMPUTER_DISPLAY: `:${cfg.display}`,
      CODEX_COMPUTER_XAUTHORITY: join(directory, "Xauthority"),
      BOTS_DESKTOP_ACTION_LOCK: join(directory, "action.lock"),
      BOTS_DESKTOP_CONTROL_LEASE: join(directory, "control.json"),
    };
  }
  policy(bot) {
    return this.runtime.store.get("browserRetention", bot.id) ?? {
      id: bot.id, botId: bot.id, profile: this.name(bot), mode: "preserve", release: null, protected: true, revision: 0,
    };
  }
  publicPolicy(bot) {
    const p = this.policy(bot);
    return { mode: p.mode, protected: p.protected, releasedAt: p.release?.at ?? null,
      closeAfterMinutes: 60, revision: p.revision, lastResult: p.lastResult ?? null, afterTaskMode: p.afterTaskMode ?? null };
  }
  savePolicy(bot, changes) {
    const old = this.policy(bot);
    if (old.botId !== bot.id || old.profile !== this.name(bot)) throw Error("Browser policy ownership mismatch.");
    return this.runtime.store.put("browserRetention", { ...old, ...changes, revision: old.revision + 1 });
  }
  async browserCommand(bot, action, expected = null) {
    await this.configured(bot);
    const args = [join(resources, "browser.py"), action, this.name(bot), "--owner", bot.id];
    if (expected) args.push("--expected", JSON.stringify(expected));
    const options = { timeout: 12000, maxBuffer: 65536, env: { ...process.env, BOTS_DESKTOP_DIR: this.base }, encoding: "utf8" };
    const raw = (await exec("/usr/bin/python3", args, options)).stdout;
    return JSON.parse(raw);
  }
  async browserAction(bot, action, params = {}) {
    return this.lock(bot, async () => {
      this.assertBot(this.runtime.store.bot(bot.id));
      if (action === "policy") {
        if (!["preserve", "idle60", "keep-task"].includes(params.mode) || params.expectedRevision !== this.policy(bot).revision)
          throw noBrowserEffect("Browser settings changed. Refresh before saving.");
        // Selecting a timeout never asserts that current tabs are safe to lose.
        const previous = this.policy(bot);
        this.savePolicy(bot, { mode: params.mode,
          afterTaskMode: params.mode === "keep-task" ? previous.mode === "keep-task" ? previous.afterTaskMode ?? "preserve" : previous.mode : null,
          protected: true, release: null, lastResult: null });
      } else if (action === "protect") {
        this.savePolicy(bot, { protected: true, release: null, lastResult: null });
      } else if (action === "release") {
        if (params.safeToClose !== true) throw noBrowserEffect("An explicit safe-to-close designation is required.");
        const token = captureActivity(this.runtime, bot.id);
        const current = this.runtime.store.bot(bot.id);
        if (this.runtime.activityUnresolved(bot.id)) throw noBrowserEffect("Native activity is uncertain; retain the browser.");
        const instance = await this.browserCommand(bot, "probe").catch(error => { error.browserNoEffect = true; throw error; });
        if (!activityUnchanged(this.runtime, bot.id, token) || this.runtime.activityUnresolved(bot.id) ||
            this.runtime.store.bot(bot.id).activeTurnId !== current.activeTurnId)
          throw noBrowserEffect("Native work changed during release. Retain the browser and review the current task.");
        if (!instance.instances.length) throw noBrowserEffect("No running assigned browser to release.");
        const release = { at: Date.now(), monotonicMs: instance.monotonicMs, boot: instance.boot, instances: instance.instances,
          turnId: current.activeTurnId ?? null, threadId: current.threadId };
        const previous = this.policy(bot);
        this.savePolicy(bot, { mode: previous.mode === "keep-task" ? previous.afterTaskMode ?? "preserve" : previous.mode,
          afterTaskMode: null, protected: false, release, lastResult: null });
      } else if (action === "reopen") {
        if (Date.now() - (this.observations.get(bot.id) ?? 0) > 60000) throw noBrowserEffect("Observe a fresh own screenshot before reopening Chrome.");
        this.savePolicy(bot, { protected: true, release: null, lastResult: null });
        await this.browserCommand(bot, "reopen");
      }
      return this.publicPolicy(bot);
    });
  }
  blockedBrowser(bot) {
    const r = this.runtime, current = r.store.bot(bot.id);
    return !current.threadId || current.archived || current.archiving || current.deletedAt || current.activeTurnId ||
      r.activityUnresolved(bot.id) || r.scheduledUncertain(bot.id) || r.store.list("pending",bot.id).length ||
      r.store.list("managerWorker",bot.id).some(w => w.activeTurnId) ||
      r.store.list("runLane",bot.id).some(w => w.activeTurnId) ||
      ["primaryInbox","promptQueue","burstBatch","messageBurst"].some(kind => r.store.list(kind,bot.id).some(x =>
        ["dispatching","uncertain","native-queued"].includes(x.state))) ||
      [...this.sessions.values()].some(s => s.bot.id === bot.id) ||
      [...this.tickets.values()].some(t => t.botId === bot.id);
  }
  async retentionTick() {
    if (this.retentionBusy) return;
    this.retentionBusy = true;
    try {
      // Only explicit candidates need a native read; preserved profiles cost nothing.
      for (const bot of this.runtime.store.bots()) {
        const p = this.policy(bot);
        if (p.mode !== "idle60" || p.protected || !p.release || Date.now() - p.release.at < 3600000 ||
            this.runtime.locks.has(bot.id) || this.locks.has(bot.id)) continue;
        await this.runtime.lock(bot.id, () => this.lock(bot, async () => {
          if (this.blockedBrowser(bot)) return;
          const policy = this.policy(bot);
          if (policy.profile !== this.name(bot) || policy.mode !== "idle60" || policy.protected || !policy.release ||
              policy.release.threadId !== bot.threadId || Date.now() - policy.release.at < 3600000) return;
          const token = captureActivity(this.runtime, bot.id);
          const { thread } = await this.runtime.codex.call("thread/read", { threadId: bot.threadId, includeTurns: false });
          if (thread?.id !== bot.threadId || thread.status?.type !== "idle" ||
              !activityUnchanged(this.runtime, bot.id, token) || this.blockedBrowser(bot)) return;
          const state = await this.browserCommand(bot, "probe");
          if (state.connected || state.monotonicMs - state.idleMs > policy.release.monotonicMs || state.idleMs < 3600000 || state.boot !== policy.release.boot ||
              JSON.stringify(state.instances) !== JSON.stringify(policy.release.instances)) return;
          if (!activityUnchanged(this.runtime, bot.id, token) || this.blockedBrowser(bot) ||
              this.policy(bot).revision !== policy.revision) return;
          // Persist the single attempt before the synchronous final, locked OS recheck.
          // This fences bridge admission and viewer/ticket creation through WM_DELETE.
          this.savePolicy(bot, { protected: true, release: null, lastResult: "Graceful close requested; prompts are never forced." });
          try {
            const args = [join(resources,"browser.py"),"close",this.name(bot),"--owner",bot.id,"--expected",JSON.stringify(policy.release)];
            execFileSync("/usr/bin/python3",args,{timeout:12000,maxBuffer:65536,stdio:["ignore","pipe","pipe"],
              env:{...process.env,BOTS_DESKTOP_DIR:this.base}});
          } catch {
            this.savePolicy(bot, { lastResult: "Close deferred or refused. Review and release again when safe." });
          }
        })).catch(() => {}); // Missing/uncertain OS/native ownership defers, never guesses.
      }
    } finally { this.retentionBusy = false; }
  }
  async call(bot, name, args, beforeInput = null) {
    if (!DESKTOP_TOOLS.some((t) => t.name === name))
      throw new Error("Unknown desktop tool.");
    this.assertBot(bot);
    if (name === "browser_status") {
      const probe = await this.browserCommand(bot, "probe");
      return { content: [{ type: "text", text: JSON.stringify({ ...this.publicPolicy(bot), memorySaver: probe.memorySaver,
        browserRunning: Boolean(probe.instances.length) }) }] };
    }
    if (name.startsWith("browser_")) {
      const action = name.slice(8);
      const result = await this.runtime.handle({ method: "desktop.browser" + action[0].toUpperCase() + action.slice(1), botId: bot.id,
        operationId: args.operation_id, params: action === "release" ? { safeToClose: args.safe_to_close } : {} });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
    return this.lock(bot, async () => {
      this.assertBot(this.runtime.store.bot(bot.id));
      // Only an observation may start a desktop; input cannot act on a fresh unseen session.
      let client = this.clients.get(bot.id);
      if (!client || client.dead) {
        if (!["screenshot", "browser_status"].includes(name))
          throw new Error(
            "Take a screenshot from this connection before input.",
          );
        const cfg = await this.start(bot);
        client = new ComputerClient(
          this.launcher,
          ["--python", join(resources, "computer-use.py")],
          this.env(bot, cfg),
        );
        this.clients.set(bot.id, client);
      }
      if (beforeInput) { await client.ready; beforeInput(); }
      if (name !== "screenshot") this.savePolicy(bot, { protected: true, release: null });
      const result = await client.call(name, args);
      if (name === "screenshot" && !result.isError) this.observations.set(bot.id, Date.now());
      return result;
    });
  }
  async status(bot) {
    try {
      const cfg = await this.configured(bot),
        running = await this.running(cfg);
      const browser = this.publicPolicy(bot);
      return {
        state: running ? "running" : "stopped",
        display: `:${cfg.display}`,
        rdpPort: cfg.rdp_port,
        rdpBind: cfg.rdp_bind,
        shared: true,
        browser,
      };
    } catch (e) {
      if (e.code === "ENOENT") return { state: "not-created", shared: true, browser: this.publicPolicy(bot) };
      throw e;
    }
  }
  async preview(bot) {
    const state = await this.status(bot);
    if (state.state !== "running") return state;
    const cached = this.previews.get(bot.id);
    if (cached?.until > Date.now()) return { ...cached.value, browser: this.publicPolicy(bot) };
    return this.lock(bot, async () => {
      const again = this.previews.get(bot.id);
      if (again?.until > Date.now()) return { ...again.value, browser: this.publicPolicy(bot) };
      const cfg = await this.configured(bot);
      const { stdout } = await exec(
        this.launcher,
        ["--python", join(resources, "capture.py")],
        {
          env: this.env(bot, cfg),
          encoding: "buffer",
          timeout: 5000,
          maxBuffer: 16 * 1024 * 1024,
        },
      );
      const png = sharp(stdout),
        metadata = await png.metadata();
      const jpeg = await png
        .resize({ width: 480, withoutEnlargement: true })
        .jpeg({ quality: 65 })
        .toBuffer();
      const value = {
        ...state,
        width: metadata.width,
        height: metadata.height,
        image: `data:image/jpeg;base64,${jpeg.toString("base64")}`,
        capturedAt: new Date().toISOString(),
      };
      this.previews.set(bot.id, { value, until: Date.now() + 4500 });
      return value;
    });
  }
  async ticket(bot, clientId) {
    this.assertBot(bot);
    if (!clientId)
      throw new Error("An authenticated browser session is required.");
    return this.lock(bot, async () => {
      await this.start(bot);
      if (this.tickets.size >= 32)
        throw new Error("Too many pending desktop connections. Wait a moment.");
      this.savePolicy(bot, { protected: true, release: null });
      const token = randomBytes(32).toString("hex");
      this.tickets.set(token, {
        botId: bot.id,
        clientId,
        expiresAt: Date.now() + 30000,
      });
      return { token, expiresAt: Date.now() + 30000 };
    });
  }
  async open(message, send) {
    const ticket = this.tickets.get(message.token);
    this.tickets.delete(message.token);
    if (
      !ticket ||
      ticket.botId !== message.botId ||
      ticket.expiresAt <= Date.now() ||
      ticket.clientId !== message.parentId
    )
      throw new Error("Desktop ticket expired or belongs to another browser.");
    if (this.sessions.size >= 8)
      throw new Error(
        "Eight live desktop dialogs are already open. Close one first.",
      );
    const bot = this.runtime.store.bot(ticket.botId);
    this.assertBot(bot);
    return this.lock(bot, async () => {
      if (
        [...this.sessions.values()].some(
          (s) => s.bot.id === bot.id && s.exclusive,
        )
      )
        throw new Error("Another browser has exclusive desktop control.");
      const cfg = await this.configured(bot);
      const session = {
        bot,
        send,
        expiresAt: Date.now() + 30000,
        exclusive: false,
        tcp: null,
        bytes: 0,
      };
      this.sessions.set(message.clientId, session);
      const tcp = connect({ host: "::1", port: cfg.vnc_port });
      session.tcp = tcp;
      tcp.setNoDelay(true);
      tcp.pause();
      tcp.on("data", (bytes) => {
        if (!this.sessions.has(message.clientId)) return;
        for (let offset = 0; offset < bytes.length; offset += 128 * 1024)
          send({
            type: "desktop",
            event: "data",
            clientId: message.clientId,
            data: bytes
              .subarray(offset, offset + 128 * 1024)
              .toString("base64"),
          });
      });
      tcp.on(
        "error",
        () =>
          void this.end(message.clientId, "Desktop transport failed.").catch(
            () => {},
          ),
      );
      tcp.on(
        "close",
        () =>
          void this.end(message.clientId, "Desktop disconnected.").catch(
            () => {},
          ),
      );
      await new Promise((resolve, reject) => {
        tcp.once("connect", resolve);
        tcp.once("error", reject);
      });
      const password = (
        await readFile(join(this.base, this.name(bot), "rdp-password"), "utf8")
      ).trim();
      // Password is sent only to this ephemeral authenticated stream; never journaled or broadcast.
      send({
        type: "desktop",
        event: "ready",
        clientId: message.clientId,
        password,
      });
      tcp.resume();
    });
  }
  async message(message, send) {
    if (message.event === "open") {
      try {
        await this.open(message, send);
      } catch (e) {
        send({
          type: "desktop",
          event: "closed",
          clientId: message.clientId,
          error: e.message,
        });
        await this.end(message.clientId, e.message);
      }
      return;
    }
    const s = this.sessions.get(message.clientId);
    if (!s) return;
    if (message.event === "close")
      return this.end(message.clientId, "Desktop closed.");
    this.assertBot(this.runtime.store.bot(s.bot.id));
    if (s.expiresAt <= Date.now())
      return this.end(message.clientId, "Desktop connection expired.");
    if (message.event === "ping") {
      s.expiresAt = Date.now() + 30000;
      if (s.exclusive)
        await this.command(s.bot, "lease-renew", message.clientId);
      return;
    }
    if (message.event === "control") {
      return this.lock(s.bot, async () => {
        try {
          if (
            message.exclusive === true &&
            [...this.sessions.values()].some(
              (other) => other !== s && other.bot.id === s.bot.id,
            )
          )
            throw new Error(
              "Close other browser desktop connections before taking exclusive control.",
            );
          await this.command(
            s.bot,
            message.exclusive === true ? "lease-acquire" : "lease-release",
            message.clientId,
          );
          s.exclusive = message.exclusive === true;
          send({
            type: "desktop",
            event: "control",
            clientId: message.clientId,
            exclusive: s.exclusive,
          });
        } catch (e) {
          send({
            type: "desktop",
            event: "control",
            clientId: message.clientId,
            exclusive: s.exclusive,
            error: e.message,
          });
        }
      });
    }
    if (message.event === "data") {
      if (
        typeof message.data !== "string" ||
        message.data.length > 192 * 1024 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(message.data)
      )
        return this.end(message.clientId, "Invalid desktop frame.");
      const bytes = Buffer.from(message.data, "base64");
      if (s.tcp.writableLength + bytes.length > 2 * 1024 * 1024)
        return this.end(message.clientId, "Desktop input buffer exceeded.");
      s.tcp.write(bytes);
    }
  }
  async end(id, error) {
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.delete(id);
    s.tcp?.destroy();
    s.send({ type: "desktop", event: "closed", clientId: id, error });
    if (s.exclusive)
      await this.command(s.bot, "lease-release", id).catch(() => {});
  }
  async stop(bot, remove = false) {
    return this.lock(bot, async () => {
      for (const [id, s] of this.sessions)
        if (s.bot.id === bot.id) await this.end(id, "Desktop stopped.");
      for (const [token, t] of this.tickets)
        if (t.botId === bot.id) this.tickets.delete(token);
      this.clients.get(bot.id)?.close();
      this.clients.delete(bot.id);
      this.previews.delete(bot.id);
      if ((await this.status(bot)).state !== "not-created")
        await this.command(bot, remove ? "remove" : "stop");
      return this.status(bot);
    });
  }
  async recover() {
    // Enforce recorded archive/deletion after downtime without starting idle bots.
    for (const bot of this.runtime.store.bots({ includeDeleted: true })) {
      if (bot.archived || bot.deletedAt)
        await this.stop(bot, Boolean(bot.deletedAt));
    }
  }
  async disconnect() {
    for (const id of [...this.sessions.keys()])
      await this.end(id, "Service disconnected.");
    this.tickets.clear();
  }
  async close() {
    clearInterval(this.retentionTimer);
    clearInterval(this.sweeper);
    await this.disconnect();
    for (const c of this.clients.values()) c.close();
  }
}
