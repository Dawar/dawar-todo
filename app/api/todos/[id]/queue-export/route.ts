import { env } from "cloudflare:workers";
import { taskQueueExportResponse } from "../../../../../lib/task-queue-export-api";
async function handle(request:Request,context:{params:Promise<{id:string}>}) {
  return taskQueueExportResponse(request,env as Cloudflare.Env,Number((await context.params).id));
}
export const GET=handle;
export const POST=handle;
