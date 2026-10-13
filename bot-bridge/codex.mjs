import { EventEmitter } from "node:events";
import { spawn, execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { CODEX_VERSION } from "./codex-version.mjs";
import { parseAccountUsageMessage } from "./account-usage-decoder.mjs";
import { closeIdleChild } from './idle-child-close.mjs';
import { EXECUTION_ACCESS, managedExecutionParams, PRIVATE_REVIEW } from './execution-access.mjs';

export { CODEX_VERSION } from "./codex-version.mjs";
export class Codex extends EventEmitter {
  constructor(binary) {
    super();
    this.binary = binary;
    this.pending = new Map();
    this.lateRecovery = new Map();
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
    this.process = spawn(this.binary, ["app-server", "--stdio", '-c', `approval_policy="${EXECUTION_ACCESS.approvalPolicy}"`, '-c', `sandbox_mode="${EXECUTION_ACCESS.sandbox}"`], {
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
      else if (this.lateRecovery.has(message.id)) {
        const p=this.lateRecovery.get(message.id);clearTimeout(p.timer);this.lateRecovery.delete(message.id);
        // Private, allowlisted receipt metadata only. No native payload enters
        // history, model context, or an ordinary app event.
        this.emit('recoveryReceipt',{requestId:message.id,method:p.method,threadId:p.threadId,
          ...(message.error ? {rpcCode:Number.isSafeInteger(message.error.code)?message.error.code:null} : p.method==='thread/unsubscribe' ?
            ['unsubscribed','notSubscribed','notLoaded'].includes(message.result?.status)?{status:message.result.status}:{unconfirmed:true} :
            message.result?.thread?.id===p.threadId?{resumedThreadId:p.threadId}:{unconfirmed:true})});
      }
      else if (this.pending.has(message.id)) {
        const p = this.pending.get(message.id);
        this.pending.delete(message.id);
        clearTimeout(p.timer);
        if (message.error) {
          const e = new Error(message.error.message);
          e.rpcCode = message.error.code;
          e.definite = true;
          p.reject(e);
        } else {
          try {
            if (p.method === "account/usage/read") message = parseAccountUsageMessage(line, p.method);
            p.resolve(message.result);
          } catch {
            p.reject(new Error("Native account usage could not be decoded without losing precision."));
          }
        }
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
      for(const p of this.lateRecovery.values())clearTimeout(p.timer);
      this.lateRecovery.clear();
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
  call(method, params = {}, timeoutMs = 120000, recovery = null) {
    params = managedExecutionParams(method, params);
    const retain=recovery?.retainRecoveryReceipt===true;
    if(retain && (!['thread/unsubscribe','thread/resume'].includes(method) ||
      this.lateRecovery.size+[...this.pending.values()].filter(p=>p.retain).length>=32 || !this.process?.stdin.writable))
      throw Object.assign(Error('Bounded native recovery transport is unavailable before submission.'),{recoveryNotSubmitted:true});
    try{this.admissionGuard?.(method, params);}catch(e){if(retain)e.recoveryNotSubmitted=true;throw e;}
    const id = ++this.counter;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        if(retain){const entry={method,threadId:params.threadId};entry.timer=setTimeout(()=>this.lateRecovery.delete(id),3600000);entry.timer.unref();this.lateRecovery.set(id,entry);}
        reject(
          new Error(
            `Codex ${method} timed out; check the conversation before retrying.`,
          ),
        );
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method, threadId: params.threadId, retain });
      try{recovery?.onRequestId?.(id);}catch(e){clearTimeout(timer);this.pending.delete(id);e.recoveryNotSubmitted=true;reject(e);return;}
      try {
        this.write({ id, method, params });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        // A write can fail after bytes were committed. Retain this exact
        // recovery receipt too; never manufacture a safe-to-repeat outcome.
        if(retain){const entry={method,threadId:params.threadId};entry.timer=setTimeout(()=>this.lateRecovery.delete(id),3600000);entry.timer.unref();this.lateRecovery.set(id,entry);}
        reject(e);
      }
    });
  }
  forkPrivateReview(params) { return this.call('thread/fork', {...params, [PRIVATE_REVIEW]:true}); }
  startPrivateReviewTurn(params) { return this.call('turn/start', {...params, [PRIVATE_REVIEW]:true}); }
  respond(id, result) {
    this.write({ id, result });
  }
  reject(id, message) {
    this.write({ id, error: { code: -32601, message } });
  }
  close() {
    this.process?.kill("SIGTERM");
  }
  closeForShutdown() {
    return this.shutdownPromise ??= closeIdleChild(this.process, { pending: this.pending.size });
  }
}
