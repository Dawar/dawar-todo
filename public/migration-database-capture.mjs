// portable/snapshot-sealing.mjs
var utf8 = new TextEncoder();
var MAXIMUM = 12 * 1024 * 1024;
function encode(bytes2) {
  let text = "";
  for (let i = 0; i < bytes2.length; i += 16384) text += String.fromCharCode(...bytes2.subarray(i, i + 16384));
  return btoa(text).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
function decode(text, maximum) {
  if (typeof text !== "string" || text.length > Math.ceil(maximum * 4 / 3) + 4 || !/^[A-Za-z0-9_-]+$/.test(text)) throw Error("Invalid sealed-snapshot field.");
  const raw = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
  if (raw.length > maximum) throw Error("Sealed snapshot exceeds its bounds.");
  const bytes2 = Uint8Array.from(raw, (c) => c.charCodeAt(0));
  if (encode(bytes2) !== text) throw Error("Noncanonical sealed-snapshot field.");
  return bytes2;
}
async function digest(bytes2) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes2)), (b) => b.toString(16).padStart(2, "0")).join("");
}
async function snapshotRecipient(publicKey) {
  const bytes2 = decode(publicKey, 256);
  return { key: await crypto.subtle.importKey("spki", bytes2, { name: "ECDH", namedCurve: "P-256" }, false, []), fingerprint: await digest(bytes2) };
}
async function sealApplicationSnapshot(snapshot, recipient, sourceOrigin) {
  const plaintext = utf8.encode(snapshot);
  if (plaintext.length > MAXIMUM || new URL(sourceOrigin).origin !== sourceOrigin || !sourceOrigin.startsWith("https://")) throw Error("Invalid application snapshot origin or size.");
  const target = await snapshotRecipient(recipient);
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey({ name: "ECDH", public: target.key }, pair.privateKey, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aad = { version: 1, kind: "dawar-application-snapshot-sealed", sourceOrigin, recipientFingerprint: target.fingerprint, contentSHA256: await digest(plaintext) };
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: utf8.encode(JSON.stringify(aad)) }, key, plaintext));
  return { ...aad, ephemeralPublicKey: encode(new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey))), iv: encode(iv), ciphertext: encode(ciphertext) };
}
var PAGE_MAXIMUM = 4 * 1024 * 1024 + 16384;
function pageId(value) {
  if (typeof value !== "string" || !value || value.includes("\0") || utf8.encode(value).length > 1024) throw Error("Invalid application read identity.");
  return value;
}
function applicationReadBinding(value) {
  const f = value?.freeze;
  if (!value || typeof value !== "object" || Object.keys(value).some((k) => !["sourceOrigin", "captureId", "requestId", "sequence", "commandSHA256", "freeze"].includes(k)) || typeof value.sourceOrigin !== "string" || new URL(value.sourceOrigin).origin !== value.sourceOrigin || !value.sourceOrigin.startsWith("https://") || !Number.isSafeInteger(value.sequence) || value.sequence < 1 || value.sequence > 1e6 || typeof value.commandSHA256 !== "string" || !/^[a-f0-9]{64}$/.test(value.commandSHA256) || !f || typeof f !== "object" || Object.keys(f).length !== (Object.hasOwn(f, "scope") ? 6 : 5) || Object.keys(f).some((k) => !["sourceId", "operationId", "epoch", "generation", "expiresAt", "scope"].includes(k)) || Object.hasOwn(f, "scope") && f.scope !== "d1-database-writes" || !Number.isSafeInteger(f.epoch) || f.epoch < 1 || !Number.isSafeInteger(f.generation) || f.generation < 1 || !Number.isSafeInteger(f.expiresAt)) throw Error("Invalid application read binding.");
  return {
    sourceOrigin: value.sourceOrigin,
    captureId: pageId(value.captureId),
    requestId: pageId(value.requestId),
    sequence: value.sequence,
    commandSHA256: value.commandSHA256,
    freeze: { sourceId: pageId(f.sourceId), operationId: pageId(f.operationId), epoch: f.epoch, generation: f.generation, expiresAt: f.expiresAt, ...Object.hasOwn(f, "scope") ? { scope: f.scope } : {} }
  };
}
async function unsealApplicationRead(envelope, recipient, expected) {
  expected = applicationReadBinding(expected);
  if (envelope?.version !== 1 || envelope.kind !== "dawar-application-read-sealed" || Object.keys(envelope).length !== 13 || Object.keys(envelope).some((k) => !["version", "kind", "sourceOrigin", "captureId", "requestId", "sequence", "commandSHA256", "freeze", "recipientFingerprint", "contentSHA256", "ephemeralPublicKey", "iv", "ciphertext"].includes(k)) || recipient?.version !== 1 || recipient.kind !== "dawar-snapshot-recipient" || typeof envelope.contentSHA256 !== "string" || !/^[a-f0-9]{64}$/.test(envelope.contentSHA256)) throw Error("Application read envelope differs.");
  const actual = applicationReadBinding(Object.fromEntries(Object.keys(expected).map((k) => [k, envelope[k]])));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw Error("Application read belongs to a different request or freeze.");
  const target = await snapshotRecipient(recipient.publicKey);
  if (target.fingerprint !== recipient.fingerprint || envelope.recipientFingerprint !== target.fingerprint) throw Error("Application read belongs to a different recipient.");
  const privateKey = await crypto.subtle.importKey("pkcs8", decode(recipient.privateKey, 256), { name: "ECDH", namedCurve: "P-256" }, false, ["deriveKey"]);
  const peer = await snapshotRecipient(envelope.ephemeralPublicKey), iv = decode(envelope.iv, 12);
  if (iv.length !== 12) throw Error("Invalid application read initialization vector.");
  const key = await crypto.subtle.deriveKey({ name: "ECDH", public: peer.key }, privateKey, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  const aad = { version: 1, kind: "dawar-application-read-sealed", ...actual, recipientFingerprint: envelope.recipientFingerprint, contentSHA256: envelope.contentSHA256 };
  const plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: utf8.encode(JSON.stringify(aad)) }, key, decode(envelope.ciphertext, PAGE_MAXIMUM + 16)));
  if (plaintext.length > PAGE_MAXIMUM || await digest(plaintext) !== envelope.contentSHA256) throw Error("Decrypted application read changed.");
  return { payload: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext)), sourceAuthenticationEstablished: false };
}

// portable/application-read-source.mjs
var MAXIMUM_LINE = 4 * 1024 * 1024;
var bytes = (value) => new TextEncoder().encode(value);
var failure = () => Error("Application snapshot read or freeze proof is invalid.");
function cellSQL(cell) {
  if (typeof cell !== "string" || bytes(cell).length > MAXIMUM_LINE / 2) throw failure();
  if (cell === "N") return "NULL";
  const value = cell.slice(1);
  if (cell[0] === "I" && /^(?:0|-?[1-9][0-9]{0,18})$/.test(value)) {
    const n = BigInt(value);
    if (n < -(1n << 63n) || n >= 1n << 63n) throw failure();
    return value;
  }
  if (cell[0] === "R") {
    if (value === "Inf") return "CAST(9e999 AS REAL)";
    if (value === "-Inf") return "CAST(-9e999 AS REAL)";
    if (/^-?(?:[0-9]+\.[0-9]*|[0-9]*\.[0-9]+|[0-9]+)(?:e[+-]?[0-9]+)?$/i.test(value) && Number.isFinite(Number(value))) {
      return `CAST(${value} AS REAL)`;
    }
  }
  if (["T", "B"].includes(cell[0]) && /^(?:[A-F0-9]{2})*$/.test(value)) {
    return cell[0] === "B" ? `X'${value}'` : `CAST(X'${value}' AS TEXT)`;
  }
  throw failure();
}
function createApplicationFreezeVerifier({ expectedFreeze, verifyFreeze, signal, stillReading = () => true }) {
  if (typeof verifyFreeze !== "function" || !expectedFreeze) throw failure();
  const expected = { sourceId: expectedFreeze.sourceId, operationId: expectedFreeze.operationId, epoch: expectedFreeze.epoch };
  const scope = expectedFreeze.scope ?? "all-application-writers";
  if (!["all-application-writers", "d1-database-writes"].includes(scope)) throw failure();
  if (typeof expected.sourceId !== "string" || !expected.sourceId || typeof expected.operationId !== "string" || !expected.operationId || !Number.isSafeInteger(expected.epoch) || expected.epoch < 1) throw failure();
  let binding, wall, observed, monotonicDeadline;
  return async () => {
    signal?.throwIfAborted();
    const proof = await verifyFreeze();
    signal?.throwIfAborted();
    const now = Date.now();
    if (!stillReading() || !proof || proof.version !== 1 || proof.kind !== "dawar-application-writer-freeze" || proof.status !== "frozen" || proof.scope !== scope || proof.sourceId !== expected.sourceId || proof.operationId !== expected.operationId || proof.epoch !== expected.epoch || proof.sourceId.length > 1024 || proof.operationId.length > 1024 || !Number.isSafeInteger(proof.generation) || proof.generation < 1 || !Number.isSafeInteger(proof.expiresAt) || proof.expiresAt <= now || proof.expiresAt - now > 9e5 || !Number.isSafeInteger(proof.observedAt) || Math.abs(proof.observedAt - now) > 5e3 || wall !== void 0 && now < wall || observed !== void 0 && proof.observedAt < observed || (scope === "all-application-writers" ? proof.admittedWriters !== 0 || proof.unknownWriters !== 0 : proof.externalWriterCoverageEstablished !== false || proof.automaticExecutionDisabled !== true || !/^[a-f0-9]{64}$/.test(proof.schemaSHA256 ?? "") || !/^[a-f0-9]{64}$/.test(proof.guardSHA256 ?? ""))) throw failure();
    const current = JSON.stringify([proof.sourceId, proof.operationId, proof.epoch, proof.generation, proof.expiresAt]);
    if (binding !== void 0 && binding !== current) throw failure();
    binding = current;
    monotonicDeadline ??= performance.now() + proof.expiresAt - now;
    if (performance.now() >= monotonicDeadline) throw failure();
    wall = now;
    observed = proof.observedAt;
    return proof;
  };
}

// portable/application-read-transport.mjs
var encoder = new TextEncoder();
var PATH = "/api/migration/application/read";
var MAXIMUM_REQUEST = 112 * 1024;
var MAXIMUM_RESPONSE = 6 * 1024 * 1024;
var failure2 = () => Error("The original authenticated application read could not be confirmed.");
var sha = async (value) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(JSON.stringify(value)))), (b) => b.toString(16).padStart(2, "0")).join("");
function captured({ sourceOrigin, captureId, freeze }) {
  const value = applicationReadBinding({ sourceOrigin, captureId, freeze, requestId: "validation-only", sequence: 1, commandSHA256: "0".repeat(64) });
  return { sourceOrigin: value.sourceOrigin, captureId: value.captureId, freeze: value.freeze };
}
function checkProof(proof, freeze) {
  if (!proof || Object.keys(freeze).some((k) => proof[k] !== freeze[k])) throw failure2();
}
function safeCommand(command) {
  if (command === null) return null;
  const text = JSON.stringify(command);
  if (typeof text !== "string" || encoder.encode(text).length > 1e5) throw failure2();
  const value = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value) || !["schema", "tables", "sequence-present", "sequences", "columns", "count", "sizes", "rows"].includes(value.kind) || Object.keys(value).some((k) => !["kind", "table", "last", "limit"].includes(k))) throw failure2();
  return value;
}
async function boundedJSON(message, maximum, signal) {
  signal.throwIfAborted();
  const length = message.headers.get("Content-Length");
  if (length !== null && (!/^(?:0|[1-9][0-9]*)$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > maximum)) throw failure2();
  if (!message.body) throw failure2();
  const reader = message.body.getReader(), chunks = [];
  let total = 0, done = false;
  try {
    while (true) {
      const next = await new Promise((resolve, reject) => {
        const aborted = () => reject(failure2());
        signal.addEventListener("abort", aborted, { once: true });
        if (signal.aborted) aborted();
        reader.read().then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
      });
      signal.throwIfAborted();
      if (next.done) {
        done = true;
        break;
      }
      if (!(next.value instanceof Uint8Array) || (total += next.value.length) > maximum || chunks.length >= 4096) throw failure2();
      chunks.push(next.value.slice());
    }
    if (length !== null && total !== Number(length)) throw failure2();
    const bytes2 = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      bytes2.set(c, offset);
      offset += c.length;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes2));
  } finally {
    if (!done) void reader.cancel().catch(() => {
    });
    reader.releaseLock();
  }
}
function laneSignal(signal, requestSignal) {
  return AbortSignal.any([AbortSignal.timeout(3e4), ...signal ? [signal] : [], ...requestSignal ? [requestSignal] : []]);
}
function createApplicationReadClient({ capture, recipient, fetchOwned, signal }) {
  const original = captured(capture), key = JSON.parse(JSON.stringify(recipient));
  if (typeof fetchOwned !== "function" || key?.version !== 1 || key.kind !== "dawar-snapshot-recipient") throw failure2();
  const endpoint = original.sourceOrigin + PATH, closing = new AbortController();
  let closed = false, active = false, sequence = 0;
  let receivedProof;
  const verify = createApplicationFreezeVerifier({
    expectedFreeze: original.freeze,
    verifyFreeze: async () => receivedProof,
    signal: AbortSignal.any([closing.signal, ...signal ? [signal] : []]),
    stillReading: () => !closed
  });
  async function exchange(command) {
    command = safeCommand(command);
    if (closed || active) throw failure2();
    active = true;
    const requestSignal = laneSignal(AbortSignal.any([closing.signal, ...signal ? [signal] : []]));
    try {
      const target = await snapshotRecipient(key.publicKey);
      requestSignal.throwIfAborted();
      if (target.fingerprint !== key.fingerprint) throw failure2();
      const binding = applicationReadBinding({ ...original, requestId: crypto.randomUUID(), sequence: ++sequence, commandSHA256: await sha(command) });
      const body = JSON.stringify({ version: 1, kind: "dawar-application-read", ...Object.fromEntries(Object.entries(binding).filter(([k]) => k !== "sourceOrigin")), recipientFingerprint: key.fingerprint, command });
      if (encoder.encode(body).length > MAXIMUM_REQUEST) throw failure2();
      const response = await fetchOwned(endpoint, {
        method: "POST",
        credentials: "include",
        redirect: "error",
        cache: "no-store",
        signal: requestSignal,
        headers: { "Content-Type": "application/json", "Origin": original.sourceOrigin },
        body
      });
      requestSignal.throwIfAborted();
      if (closed || !(response instanceof Response) || response.status !== 200 || response.redirected || response.url !== endpoint || response.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !== "application/json") throw failure2();
      const envelope = await boundedJSON(response, MAXIMUM_RESPONSE, requestSignal);
      const { payload } = await unsealApplicationRead(envelope, key, binding);
      requestSignal.throwIfAborted();
      if (!payload || typeof payload !== "object" || Array.isArray(payload) || Object.keys(payload).length !== 2 || !Object.hasOwn(payload, "rows") || !Object.hasOwn(payload, "proof") || command === null && payload.rows !== null || command !== null && (!Array.isArray(payload.rows) || payload.rows.length > 4e3 || encoder.encode(JSON.stringify(payload.rows)).length > 4 * 1024 * 1024)) throw failure2();
      checkProof(payload.proof, original.freeze);
      receivedProof = payload.proof;
      await verify();
      return payload;
    } finally {
      active = false;
    }
  }
  return {
    read: async (command) => (await exchange(command)).rows,
    verifyFreeze: async () => (await exchange(null)).proof,
    close() {
      closed = true;
      closing.abort();
    },
    get idle() {
      return !active;
    }
  };
}

// portable/browser-database-capture.mjs
var encode2 = (v) => new TextEncoder().encode(v);
var line = (v) => JSON.stringify(v) + "\n";
var hash = async (v) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", encode2(v))), (b) => b.toString(16).padStart(2, "0")).join("");
var fail = () => Error("The original database capture is incomplete. Keep production and original receipts unchanged.");
async function captureDatabase({ capture, recipient, onProgress = () => {
} }) {
  if (capture?.freeze?.scope !== "d1-database-writes" || location.origin !== capture.sourceOrigin) throw fail();
  const client = createApplicationReadClient({ capture, recipient, fetchOwned: (url, init) => fetch(url, init) });
  let calls = 0;
  const read = async (command) => {
    calls++;
    return client.read(command);
  };
  try {
    const schema = await read({ kind: "schema" }), list = await read({ kind: "tables" }), tables = [];
    for (const item of schema.filter((s) => s.type === "table")) {
      const table = list.find((t) => t.schema === "main" && t.name === item.name);
      if (!table || table.type !== "table") throw fail();
      const x = await read({ kind: "columns", table: item.name }), columns = x.filter((c) => c.hidden === 0).map((c) => c.name);
      let order;
      if (table.wr) order = x.filter((c) => c.pk).sort((a, b) => a.pk - b.pk).map((c) => c.name);
      else {
        const k = ["_rowid_", "rowid", "oid"].find((n) => !x.some((c) => c.name.toLowerCase() === n));
        if (!k) throw fail();
        columns.unshift(k);
        order = [k];
      }
      const count = await read({ kind: "count", table: item.name }), rows = count[0]?.n;
      if (!Number.isSafeInteger(rows) || rows < 0 || rows > 1e7 || !columns.length || !order.length) throw fail();
      tables.push({ name: item.name, columns, order, rows });
    }
    if (tables.length > 1e3 || tables.reduce((n, t) => n + t.rows, 0) > 1e7) throw fail();
    const sequence = (await read({ kind: "sequence-present" })).length ? await read({ kind: "sequences" }) : [];
    const header = { kind: "header", format: "dawar-application-snapshot", version: 2, schema, tables, sequence, userVersion: null, applicationId: null, sourceMetadata: { engine: "cloudflare-d1", sqliteHeader: "unavailable" } };
    const content = [line(header)], inventory = [];
    let total = encode2(content[0]).length;
    for (const t of tables) {
      const records = [];
      let last = null, rows = 0;
      for (; ; ) {
        const sizes = await read({ kind: "sizes", table: t.name, last, limit: 256 });
        let limit = 0, weight = 0;
        for (const s of sizes) {
          if (!Number.isSafeInteger(s.bytes) || s.bytes > 4 * 1024 * 1024 || s.bytes < 0) throw fail();
          t.order.forEach((_, i) => cellSQL(s["k" + i]));
          if (limit && weight + s.bytes > 1024 * 1024) break;
          weight += s.bytes;
          limit++;
        }
        if (!limit) break;
        const data = await read({ kind: "rows", table: t.name, last, limit });
        if (data.length !== limit) throw fail();
        for (const r of data) {
          const cells = t.columns.map((_, i) => r["c" + i]);
          cells.forEach(cellSQL);
          if (++rows > t.rows) throw fail();
          const text3 = line({ kind: "row", table: t.name, cells });
          total += encode2(text3).length;
          if (total > 256 * 1024 * 1024) throw fail();
          records.push(text3);
          last = t.order.map((k) => cells[t.columns.indexOf(k)]);
        }
        onProgress({ tables: inventory.length, rows, calls });
      }
      if (rows !== t.rows || (await read({ kind: "count", table: t.name }))[0]?.n !== t.rows) throw fail();
      const text2 = records.join("");
      inventory.push({ name: t.name, rows, sha256: await hash(text2) });
      content.push(text2);
    }
    if (JSON.stringify(await read({ kind: "schema" })) !== JSON.stringify(schema)) throw fail();
    const proof = await client.verifyFreeze(), text = content.join(""), footer = line({ kind: "footer", tables: inventory, sha256: await hash(text) }), complete = text + footer;
    const chunks = [];
    let part = [], partBytes = 0;
    for (const section of [...content, footer]) {
      for (const record of section.split(/(?<=\n)/)) {
        const size = encode2(record).length;
        if (size > 4 * 1024 * 1024) throw fail();
        if (partBytes && partBytes + size > 8 * 1024 * 1024) {
          chunks.push(await sealApplicationSnapshot(part.join(""), recipient.publicKey, capture.sourceOrigin));
          part = [];
          partBytes = 0;
        }
        part.push(record);
        partBytes += size;
      }
    }
    if (partBytes) chunks.push(await sealApplicationSnapshot(part.join(""), recipient.publicKey, capture.sourceOrigin));
    await client.verifyFreeze();
    return { version: 1, kind: "dawar-database-capture-chunks", capture, proof, bytes: encode2(complete).length, sha256: await hash(complete), chunks, tables: inventory, calls, recentTailLossAccepted: true, fullExternalWriterFreezeEstablished: false };
  } finally {
    client.close();
  }
}
function openDatabaseCapture() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".json";
  input.addEventListener("change", async () => {
    try {
      const file = input.files?.[0];
      if (!file || file.size > 32768) throw fail();
      const { capture, recipient } = JSON.parse(await file.text());
      const result = await captureDatabase({ capture, recipient, onProgress: (p) => console.info("Private database capture progress", p) });
      const link = document.createElement("a"), url = URL.createObjectURL(new Blob([JSON.stringify(result)], { type: "application/json" }));
      link.href = url;
      link.download = "dawar-application-database-capture.sealed.json";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 3e4);
      console.info("Private database capture finished", { tables: result.tables.length, bytes: result.bytes, calls: result.calls });
    } catch {
      console.error("Private database capture failed; original receipts and production retained.");
    } finally {
      input.remove();
    }
  }, { once: true });
  input.click();
}
export {
  captureDatabase,
  openDatabaseCapture
};
