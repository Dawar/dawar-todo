import { env } from "cloudflare:workers";
import { botStorageResponse } from "../../../../../lib/bot-storage-api";
// Only this exact transport bypasses owner-session middleware. Its own separate
// service credential and machine binding are required before any D1/S3 access.
export function POST(request: Request) { return botStorageResponse(request,env as Cloudflare.Env,true); }
