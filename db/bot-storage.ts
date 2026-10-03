import { createHash } from "node:crypto";
import { createS3Storage, type S3Environment } from "../lib/s3-storage";
import type { BotArtifact, BotAttachment } from "../lib/bots-types";
import { artifactMime } from "../lib/bot-file-metadata.mjs";

export type BotStorageEnv = S3Environment & { DB: D1Database; BOTS_MACHINE_ID?: string; BOTS_STORAGE_ENABLED?: string };
type Identity = { id: string; name: string; color: string; archived: boolean };
type FileRow = { owner_key: string; id: string; bot_id: string; fingerprint: string; staging_key: string; object_key: string; state: string; metadata: string; parent_id: string | null; seq: number };
export class StorageError extends Error { constructor(message: string, public status = 400, public code = "invalid") { super(message); } }
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const MAX_BYTES = 100 * 1024 * 1024;
const encodeCursor = (value:unknown) => btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value))));
const decodeCursor = (value:string) => JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(value),character=>character.charCodeAt(0))));
const initialized = new WeakMap<D1Database, Promise<unknown>>();
export const BOT_STORAGE_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS bot_storage_identities(owner_key TEXT NOT NULL,id TEXT NOT NULL,machine_id TEXT NOT NULL,metadata TEXT NOT NULL,PRIMARY KEY(owner_key,id))`,
  `CREATE TABLE IF NOT EXISTS bot_storage_files(seq INTEGER PRIMARY KEY AUTOINCREMENT,owner_key TEXT NOT NULL,id TEXT NOT NULL,bot_id TEXT NOT NULL,fingerprint TEXT NOT NULL,staging_key TEXT NOT NULL,object_key TEXT NOT NULL,state TEXT NOT NULL,metadata TEXT NOT NULL,parent_id TEXT,UNIQUE(owner_key,id))`,
  `CREATE INDEX IF NOT EXISTS bot_storage_catalog ON bot_storage_files(owner_key,bot_id,state,seq)`,
  `CREATE INDEX IF NOT EXISTS bot_storage_derivatives ON bot_storage_files(owner_key,parent_id,state)`,
  `CREATE TABLE IF NOT EXISTS bot_storage_ready(seq INTEGER PRIMARY KEY AUTOINCREMENT,owner_key TEXT NOT NULL,id TEXT NOT NULL,UNIQUE(owner_key,id))`,
];
export function ensureBotStorage(db: D1Database) {
  let task = initialized.get(db);
  if (!task) { task = db.batch(BOT_STORAGE_SCHEMA.map(sql => db.prepare(sql))).catch(error => { initialized.delete(db); throw error; }); initialized.set(db, task); }
  return task;
}
function validId(value: unknown): string {
  if (typeof value !== "string" || !/^[\w:.-]{1,200}$/.test(value)) throw new StorageError("Invalid registered attachment or bot ID.");
  return value;
}
function cleanMetadata(input: Record<string, unknown>, service: boolean) {
  const id = validId(input.id), botId = validId(input.botId);
  const size = Number(input.size), sha256 = String(input.sha256 ?? "");
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_BYTES || !/^[a-f0-9]{64}$/.test(sha256)) throw new StorageError("Files require a SHA-256 checksum and at most 100 MB.");
  const name = String(input.name ?? "file").split(/[\\/]/).at(-1)!.replace(/[\x00-\x1f\x7f]/g, "").slice(0,160) || "file";
  const mimeType = String(input.mimeType ?? "application/octet-stream");
  if (!/^[\w.+-]+\/[\w.+-]+$/.test(mimeType)) throw new StorageError("Invalid file media type.");
  if (!service && (!/^[a-f0-9-]{36}$/i.test(id) || input.artifact || input.parentId)) throw new StorageError("Browser uploads require their original upload ID.");
  const provenance: Record<string,string> = {};
  if (service && input.provenance && typeof input.provenance === "object") for (const [key, value] of Object.entries(input.provenance)) {
    if (["threadId","turnId","itemId","operationId","runId","laneId"].includes(key) && typeof value === "string" && value.length <= 200) provenance[key] = value;
  }
  const createdAt = service && (input.createdAt === null || typeof input.createdAt === "string" && Number.isFinite(Date.parse(input.createdAt))) ? input.createdAt as string | null : null;
  return { id, botId, size, sha256, name, mimeType: artifactMime(name,mimeType), artifact: service && input.artifact === true,
    source: service && input.source === "native" ? "native" as const : service && input.artifact ? "published" as const : "upload" as const,
    createdAt, provenance, ...(service && input.peerSource && typeof input.peerSource === "object" ? { peerSource: input.peerSource } : {}) };
}
type Metadata = ReturnType<typeof cleanMetadata>;
export class BotStorage {
  private storage;
  constructor(private environment: BotStorageEnv, private owner: string, private service: boolean) { this.storage = createS3Storage(environment); }
  async initialize() { await ensureBotStorage(this.environment.DB); }
  private async row(id: string, botId: string) {
    const row = await this.environment.DB.prepare("SELECT * FROM bot_storage_files WHERE owner_key=? AND id=? AND bot_id=?").bind(this.owner, validId(id), validId(botId)).first<FileRow>();
    if (!row) throw new StorageError("Registered file not found for this bot.", 404, "not_found");
    return row;
  }
  async registerBots(bots: Identity[]) {
    if (!this.service || !Array.isArray(bots) || bots.length > 500) throw new StorageError("Storage service access required.",403);
    const statements = bots.map(bot => {
      const metadata = { id: validId(bot.id), name: String(bot.name).slice(0,200), color: String(bot.color).slice(0,40), archived: Boolean(bot.archived) };
      return this.environment.DB.prepare("INSERT INTO bot_storage_identities VALUES(?,?,?,?) ON CONFLICT(owner_key,id) DO UPDATE SET metadata=excluded.metadata WHERE machine_id=excluded.machine_id").bind(this.owner, metadata.id, this.environment.BOTS_MACHINE_ID ?? "dawar-vm", JSON.stringify(metadata));
    });
    if (statements.length) await this.environment.DB.batch(statements);
    return { registered: statements.length };
  }
  private receipt(row: FileRow): BotAttachment & { sha256: string; cloudState: "ready" } {
    const {searchName,dateKey,...metadata}=JSON.parse(row.metadata);
    void searchName; void dateKey;
    return { ...metadata, ready: true, cloudState: "ready" };
  }
  async prepare(input: Record<string, unknown>) {
    const metadata = cleanMetadata(input, this.service);
    const identity = await this.environment.DB.prepare("SELECT metadata FROM bot_storage_identities WHERE owner_key=? AND id=? AND machine_id=?").bind(this.owner,metadata.botId,this.environment.BOTS_MACHINE_ID ?? "dawar-vm").first();
    if (!identity) throw new StorageError("Bot is not registered with this storage service.",404,"not_found");
    const parentId = this.service && input.parentId ? validId(input.parentId) : null;
    if (parentId) { const parent = await this.row(parentId, metadata.botId); if (parent.state !== "ready" || metadata.mimeType !== "image/webp" || metadata.size > 128 * 1024) throw new StorageError("Invalid thumbnail publication."); }
    const fingerprint = hash(JSON.stringify([metadata.botId,metadata.name,metadata.size,metadata.mimeType,metadata.sha256,metadata.artifact,metadata.source,parentId]));
    const prefix = `bots/${hash(this.owner)}/${hash(metadata.botId)}/${hash(metadata.id)}`;
    const createdAt=metadata.createdAt ?? (this.service ? null : new Date().toISOString());
    await this.environment.DB.prepare("INSERT OR IGNORE INTO bot_storage_files(owner_key,id,bot_id,fingerprint,staging_key,object_key,state,metadata,parent_id) VALUES(?,?,?,?,?,?,'pending',?,?)")
      .bind(this.owner,metadata.id,metadata.botId,fingerprint,`${prefix}/staging`,`${prefix}/${metadata.sha256}/original`,JSON.stringify({ ...metadata, searchName:metadata.name.normalize("NFKC").toLowerCase(), dateKey:createdAt === null ? -8640000000000001 : Date.parse(createdAt), createdAt }),parentId).run();
    const row = await this.row(metadata.id,metadata.botId);
    if (row.fingerprint !== fingerprint) throw new StorageError("This attachment ID already describes a different file. Original registration retained.",409,"conflict");
    // Service enrichment cannot change byte identity or immutable registration.
    if (this.service && Object.keys(metadata.provenance).length) {
      const stored = JSON.parse(row.metadata);
      row.metadata = JSON.stringify({ ...stored, provenance: { ...stored.provenance, ...metadata.provenance } });
      await this.environment.DB.prepare("UPDATE bot_storage_files SET metadata=? WHERE owner_key=? AND id=? AND fingerprint=?").bind(row.metadata,this.owner,row.id,fingerprint).run();
    }
    if (row.state === "ready") return { attachment: this.receipt(row) };
    return { uploadId: row.id, upload: await this.storage.signedPostTarget(row.staging_key,metadata.mimeType,metadata.size,0), cloudState: row.state };
  }
  private async verify(key: string, metadata: Metadata) {
    const response = await this.storage.storageFetch(this.storage.storageUrl(key));
    if (!response.body) throw new StorageError("Storage returned no file bytes.",502,"integrity");
    const digest = createHash("sha256"); let size = 0;
    const reader = response.body.getReader();
    try { for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > metadata.size) throw new StorageError("Cloud file size mismatch.",422,"integrity"); digest.update(next.value); } }
    finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    if (size !== metadata.size || digest.digest("hex") !== metadata.sha256) throw new StorageError("Cloud file checksum mismatch. Local bytes are retained.",422,"integrity");
    const etag = response.headers.get("etag");
    if (!etag) throw new StorageError("Storage did not provide a copy identity.",502,"integrity");
    return etag;
  }
  async finalize(id: string, botId: string) {
    const row = await this.row(id,botId);
    if (row.state === "ready") return { attachment: this.receipt(row) };
    const metadata: Metadata = JSON.parse(row.metadata);
    try {
      // A lost acknowledgement may leave a valid immutable copy but no D1 receipt.
      let retained = false;
      const head = await this.storage.signedStorageResponse(this.storage.storageUrl(row.object_key), { method: "HEAD" });
      if (head.ok) {
        try { await this.verify(row.object_key,metadata); retained = true; }
        catch (error) { if (!(error instanceof StorageError) || error.code !== "integrity") throw error; }
      }
      else if (head.status !== 404) throw new StorageError("Cloud copy status is uncertain; retry this same attachment ID.",502,"uncertain");
      if (!retained) {
        const etag = await this.verify(row.staging_key,metadata);
        await this.storage.copyObject(row.staging_key,row.object_key,etag);
        await this.verify(row.object_key,metadata);
      }
      await this.environment.DB.batch([
        this.environment.DB.prepare("UPDATE bot_storage_files SET state='ready' WHERE owner_key=? AND id=? AND fingerprint=?").bind(this.owner,id,row.fingerprint),
        this.environment.DB.prepare("INSERT OR IGNORE INTO bot_storage_ready(owner_key,id) VALUES(?,?)").bind(this.owner,id),
      ]);
      const saved = await this.row(id,botId);
      if (saved.state !== "ready") throw new StorageError("Cloud publication receipt is uncertain.",502,"uncertain");
      return { attachment: this.receipt(saved) };
    } catch (error) {
      await this.environment.DB.prepare("UPDATE bot_storage_files SET state='failed' WHERE owner_key=? AND id=? AND state<>'ready'").bind(this.owner,id).run().catch(() => {});
      throw error;
    }
  }
  async download(id: string, botId: string, preview = false) {
    let row = await this.row(id,botId);
    if (row.state !== "ready") throw new StorageError("File awaits cloud migration or upload completion.",409,"not_ready");
    if (preview) {
      const child = await this.environment.DB.prepare("SELECT * FROM bot_storage_files WHERE owner_key=? AND bot_id=? AND parent_id=? AND state='ready' ORDER BY seq DESC LIMIT 1").bind(this.owner,botId,id).first<FileRow>();
      if (!child) throw new StorageError("Thumbnail unavailable. The original remains accessible.",404,"no_preview");
      row = child;
    }
    const metadata: Metadata = JSON.parse(row.metadata);
    return { attachment: this.receipt(row), url: await this.storage.signedObjectUrl(row.object_key,metadata.name), expiresAt: new Date(Date.now()+60*60*1000).toISOString() };
  }
  async share(input: { id: string; botId: string; recipientBotId: string; attachmentId: string; exchangeId: string; createdAt?:string }) {
    if (!this.service) throw new StorageError("Explicit bridge peer grant required.",403);
    const row = await this.row(input.id,input.botId);
    if (row.state !== "ready" || row.parent_id) throw new StorageError("Share a ready registered original.");
    const source: Metadata = JSON.parse(row.metadata);
    const createdAt=typeof input.createdAt === "string" && Number.isFinite(Date.parse(input.createdAt)) ? input.createdAt : source.createdAt;
    const metadata = { ...source, id: validId(input.attachmentId), botId: validId(input.recipientBotId), artifact: false, source: "upload",
      createdAt,dateKey:createdAt === null ? -8640000000000001 : Date.parse(createdAt),
      provenance: {}, peerSource: { botId: source.botId, attachmentId: source.id, exchangeId: validId(input.exchangeId) } };
    const bot = await this.environment.DB.prepare("SELECT id FROM bot_storage_identities WHERE owner_key=? AND id=?").bind(this.owner,metadata.botId).first();
    if (!bot) throw new StorageError("Recipient bot not registered.",404);
    const fingerprint = hash(JSON.stringify([metadata.botId,metadata.name,metadata.size,metadata.mimeType,metadata.sha256,false,"upload",null]));
    await this.environment.DB.prepare("INSERT OR IGNORE INTO bot_storage_files(owner_key,id,bot_id,fingerprint,staging_key,object_key,state,metadata) VALUES(?,?,?,?,?,?,'ready',?)")
      .bind(this.owner,metadata.id,metadata.botId,fingerprint,row.staging_key,row.object_key,JSON.stringify(metadata)).run();
    const saved = await this.row(metadata.id,metadata.botId);
    const peer = JSON.parse(saved.metadata).peerSource;
    if (saved.fingerprint !== fingerprint || peer?.exchangeId !== input.exchangeId || peer?.botId !== input.botId || peer?.attachmentId !== input.id) throw new StorageError("Peer grant identity conflict.",409);
    await this.environment.DB.prepare("INSERT OR IGNORE INTO bot_storage_ready(owner_key,id) VALUES(?,?)").bind(this.owner,metadata.id).run();
    return { attachment: this.receipt(saved) };
  }
  async copy(input: { id: string; botId: string; recipientBotId: string; attachmentId: string }) {
    const row = await this.row(input.id,input.botId);
    if (row.state !== "ready" || row.parent_id) throw new StorageError("Choose a ready original attachment.",409,"not_ready");
    const botId = validId(input.recipientBotId), id = validId(input.attachmentId);
    if (!/^[a-f0-9-]{36}$/i.test(id)) throw new StorageError("Invalid composer attachment ID.");
    const identity = await this.environment.DB.prepare("SELECT metadata FROM bot_storage_identities WHERE owner_key=? AND id=? AND machine_id=?").bind(this.owner,botId,this.environment.BOTS_MACHINE_ID ?? "dawar-vm").first<{metadata:string}>();
    if (!identity || JSON.parse(identity.metadata).archived) throw new StorageError("Recipient bot is unavailable.",404,"not_found");
    const source: Metadata = JSON.parse(row.metadata);
    const createdAt = new Date().toISOString();
    const metadata = { ...source, id, botId, artifact:false, source:"upload", provenance:{}, peerSource:undefined,
      composerSource:{botId:source.botId,attachmentId:source.id},createdAt,dateKey:Date.parse(createdAt) };
    const fingerprint = hash(JSON.stringify(["composer",botId,source.botId,source.id,source.sha256,source.size,source.name,source.mimeType]));
    await this.environment.DB.prepare("INSERT OR IGNORE INTO bot_storage_files(owner_key,id,bot_id,fingerprint,staging_key,object_key,state,metadata) VALUES(?,?,?,?,?,?,'ready',?)")
      .bind(this.owner,id,botId,fingerprint,row.staging_key,row.object_key,JSON.stringify(metadata)).run();
    const saved = await this.row(id,botId);
    if (saved.fingerprint !== fingerprint || saved.state !== "ready") throw new StorageError("Attachment transfer identity conflict.",409,"conflict");
    await this.environment.DB.prepare("INSERT OR IGNORE INTO bot_storage_ready(owner_key,id) VALUES(?,?)").bind(this.owner,id).run();
    return { attachment:this.receipt(saved) };
  }
  async list(input: Record<string,string>) {
    const limit = Number(input.limit ?? 36), sort = input.sort ?? "newest", type = input.type ?? "all", direction = input.direction ?? "all", needle = (input.search ?? "").trim().normalize("NFKC").toLowerCase();
    if (!Number.isInteger(limit) || limit < 1 || limit > 60 || !["newest","oldest","name"].includes(sort) || !["all","image","pdf","document","audio","video","other"].includes(type) || !["all","input","output"].includes(direction) || needle.length > 160) throw new StorageError("Invalid catalog filters.");
    const scope = hash(JSON.stringify([this.owner,input.botId ?? null,needle,type,direction,sort]));
    const where = ["f.owner_key=?","f.state='ready'","f.parent_id IS NULL"], values: (string|number)[] = [this.owner];
    if (input.botId) { where.push("f.bot_id=?"); values.push(validId(input.botId)); }
    // MIME kinds mirror artifact-library; JSON paths preserve provenance and IDs.
    const kind = `CASE WHEN json_extract(f.metadata,'$.mimeType')='application/pdf' THEN 'pdf' WHEN json_extract(f.metadata,'$.mimeType') LIKE 'image/%' THEN 'image' WHEN json_extract(f.metadata,'$.mimeType') LIKE 'audio/%' THEN 'audio' WHEN json_extract(f.metadata,'$.mimeType') LIKE 'video/%' THEN 'video' WHEN json_extract(f.metadata,'$.mimeType') LIKE 'text/%' OR json_extract(f.metadata,'$.mimeType') LIKE '%json%' OR json_extract(f.metadata,'$.mimeType') LIKE '%officedocument%' OR json_extract(f.metadata,'$.mimeType') LIKE '%msword%' OR json_extract(f.metadata,'$.mimeType') LIKE '%opendocument%' OR json_extract(f.metadata,'$.mimeType') LIKE '%rtf%' THEN 'document' ELSE 'other' END`;
    if (type !== "all") { where.push(`(${kind})=?`); values.push(type); }
    if (direction !== "all") { where.push("json_extract(f.metadata,'$.artifact')=?"); values.push(direction === "output" ? 1 : 0); }
    // JS normalization at registration is stored independently of the filename.
    if (needle) { where.push("instr(json_extract(f.metadata,'$.searchName'),?)>0"); values.push(needle); }
    const key = sort === "name" ? "json_extract(f.metadata,'$.searchName')" : "json_extract(f.metadata,'$.dateKey')";
    const order = sort === "newest" ? "DESC" : "ASC", comparison = sort === "newest" ? "<" : ">";
    let cursor: { scope:string; ceiling:number; key:string|number; id:string } | null = null;
    if (input.cursor) { try { if (input.cursor.length>4096) throw new Error(); cursor = decodeCursor(input.cursor); if (!cursor || cursor.scope !== scope || !Number.isSafeInteger(cursor.ceiling) || cursor.ceiling < 0 || (sort === "name" ? typeof cursor.key !== "string" : typeof cursor.key !== "number") || !Number.isFinite(sort === "name" ? 0 : cursor.key) || typeof cursor.id !== "string") throw new Error(); } catch { throw new StorageError("Catalog cursor does not match these filters."); } }
    const ceiling = cursor?.ceiling ?? (await this.environment.DB.prepare("SELECT COALESCE(MAX(seq),0) AS n FROM bot_storage_ready WHERE owner_key=?").bind(this.owner).first<{n:number}>())!.n;
    where.push("r.seq<=?"); values.push(ceiling);
    if (cursor) { where.push(`(${key} ${comparison} ? OR (${key}=? AND f.id ${comparison} ?))`); values.push(cursor.key,cursor.key,cursor.id); }
    const rows = await this.environment.DB.prepare(`SELECT f.*,b.metadata AS bot,(${kind}) AS kind,${key} AS sort_key FROM bot_storage_files f JOIN bot_storage_identities b ON b.owner_key=f.owner_key AND b.id=f.bot_id JOIN bot_storage_ready r ON r.owner_key=f.owner_key AND r.id=f.id WHERE ${where.join(" AND ")} ORDER BY ${key} ${order},f.id ${order} LIMIT ?`).bind(...values,limit+1).all<FileRow & {bot:string;kind:BotArtifact["kind"];sort_key:string|number}>();
    const page = rows.results.slice(0,limit), last = page.at(-1);
    const items = page.map(row => { const a: Metadata = JSON.parse(row.metadata), bot: Identity = JSON.parse(row.bot); return { ...this.receipt(row), botName: bot.name,botColor: bot.color,botArchived: bot.archived,kind: row.kind,direction: a.artifact ? "output" : "input",preview: {kind: ["image","pdf"].includes(row.kind) ? row.kind : "none",version: hash(JSON.stringify([a.id,a.botId,a.size,a.mimeType,a.createdAt,a.sha256])).slice(0,24)} }; });
    return { items, nextCursor: rows.results.length > limit && last ? encodeCursor({scope,ceiling,key:last.sort_key,id:last.id}) : null };
  }
}
