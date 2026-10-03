import { env } from "cloudflare:workers";
import { botStorageResponse } from "../../../../lib/bot-storage-api";
export function GET(request: Request) { return botStorageResponse(request,env as Cloudflare.Env); }
export function POST(request: Request) { return botStorageResponse(request,env as Cloudflare.Env); }
