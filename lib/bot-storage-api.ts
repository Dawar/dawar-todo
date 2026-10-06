import { confirmTaskDelegation, type DelegationInput } from "../db/task-queue-delegation";
import { BotStorage, StorageError, type BotStorageEnv } from "../db/bot-storage";
import { botsOwner, secretMatches } from "./bots-auth";
import { createS3Storage } from "./s3-storage";
import { TaskQueueExports } from "../db/task-queue-exports";

type Environment = BotStorageEnv & Cloudflare.Env & { BOTS_STORAGE_SERVICE_SECRET?: string; BOTS_STORAGE_CATALOG_READY?: string };
export async function botStorageResponse(request: Request, environment: Environment, service = false) {
  const headers = { "Cache-Control": "no-store" };
  try {
    let owner: string;
    if (service) {
      const credential = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ?? "";
      if (!environment.BOTS_STORAGE_SERVICE_SECRET || !(await secretMatches(credential,environment.BOTS_STORAGE_SERVICE_SECRET)) ||
          request.headers.get("X-Bots-Machine") !== (environment.BOTS_MACHINE_ID ?? "dawar-vm")) return Response.json({ error:"Unauthorized",code:"unauthorized" },{ status:401,headers });
      owner = environment.BOTS_OWNER_EMAIL?.trim().toLowerCase() ?? "";
      if (!owner) throw new StorageError("Storage owner is not configured.",503,"unavailable");
    } else { try { owner = botsOwner(request,environment); } catch { throw new StorageError("Storage requires the owner's signed-in session.",401,"unauthorized"); } }
    const url = new URL(request.url);
    const input: Record<string, unknown> = request.method === "GET" ? Object.fromEntries(url.searchParams) : await boundedJson(request);
    const action = String(input.action ?? "status");
    if (action === "status") return Response.json({ owner,enabled: environment.BOTS_STORAGE_ENABLED === "1", catalogReady: environment.BOTS_STORAGE_CATALOG_READY === "1", portableCopy:true,taskQueueExports:1 },{headers});
    if (action === "providerCors") {
      if (!service) throw new StorageError("Provider configuration checks require the storage service credential.",403,"forbidden");
      if (request.method !== "POST") throw new StorageError("Use POST for private provider checks.",405);
      return Response.json({ providerCors: await createS3Storage(environment).readBucketCors() },{headers});
    }
    if (!service && ["prepare","finalize"].includes(action) && environment.BOTS_STORAGE_ENABLED !== "1") throw new StorageError("Direct cloud transfers are not enabled yet.",503,"disabled");
    if (request.method === "GET" && !["list","download","preview"].includes(action)) throw new StorageError("Use POST for storage mutations.",405);
    const storage = new BotStorage(environment,owner,service); await storage.initialize();
    let result;
    switch (action) {
      case "taskQueueDelegate": {
        if(!service) throw new StorageError("Private queue acceptance confirmation required.",403,"forbidden");
        result=await confirmTaskDelegation(environment,owner,input as unknown as DelegationInput); break;
      }
      case "taskQueueExport": {
        if(!service) throw new StorageError("Private storage service receipt resolution required.",403,"forbidden");
        result=await new TaskQueueExports(environment,owner).resolve(String(input.taskExportId),String(input.botId)); break;
      }
      case "registerBots": result = await storage.registerBots(input.bots as Parameters<BotStorage["registerBots"]>[0]); break;
      case "prepare": result = await storage.prepare(input); break;
      case "finalize": result = await storage.finalize(String(input.id),String(input.botId)); break;
      case "download": case "preview": result = await storage.download(String(input.id),String(input.botId),action === "preview"); break;
      case "list": result = await storage.list(input as Record<string,string>); break;
      case "share": result = await storage.share(input as Parameters<BotStorage["share"]>[0]); break;
      case "copy": result = await storage.copy(input as Parameters<BotStorage["copy"]>[0]); break;
      default: throw new StorageError("Unknown storage action.");
    }
    return Response.json({ ...result,owner },{headers});
  } catch (error) {
    const known = error instanceof StorageError;
    // Provider errors may contain signed URLs or secret material; never echo them.
    return Response.json({ error:known ? error.message : "Cloud storage operation failed. Retry the same attachment ID; local files are retained.",code:known ? error.code : "unavailable" },{ status:known ? error.status : 502,headers });
  }
}
async function boundedJson(request: Request): Promise<Record<string,unknown>> {
  if (!request.body) throw new StorageError("Missing storage request.");
  const reader = request.body.getReader(), chunks: Uint8Array[] = []; let size=0;
  try { for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.length; if (size > 128*1024) throw new StorageError("Storage metadata request is too large.",413); chunks.push(next.value); } }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset=0; for (const chunk of chunks) { bytes.set(chunk,offset); offset += chunk.length; }
  try { const input = JSON.parse(new TextDecoder().decode(bytes)); if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error(); return input; }
  catch { throw new StorageError("Invalid storage metadata."); }
}
