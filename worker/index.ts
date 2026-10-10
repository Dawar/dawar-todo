/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { syncEventsResponse } from "./sync-events";
import { agentInstallerResponse } from "./agent-installer";
import { appAccessResponse } from "./access";
import { runTodoMinuteMaintenance } from "../db/minute-maintenance";
import { handleTalkPhoneStream } from "./talk-phone-stream";
import {runSourceWriterWork} from "../portable/source-writer-scope.mjs";
import type {SourceWriterBinding} from "../portable/source-writer-admission.mjs";
import {applicationMigrationControlResponse} from '../lib/application-migration-control';

interface Env {
  ASSETS: Fetcher;
  MIGRATION_SOURCE_WRITER_ADMISSION?:string;
  MIGRATION_SOURCE_CONTROL?:string;
  BOTS_OWNER_EMAIL?: string;
  BOTS_OWNER_USER_ID?: string;
  DB: D1Database;
  S3_ACCESS_KEY: string;
  S3_ACCESS_KEY_ID: string;
  S3_BUCKET: string;
  S3_CDN_URL: string;
  S3_ENDPOINT_URL: string;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
  VAPID_SUBJECT?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  OPENAI_API_KEY?: string;
  OPENAI_PROJECT_ID?: string;
  OPENAI_REALTIME_MODEL?: string;
  OPENAI_REALTIME_VOICE?: string;
  OPENAI_ASSISTANT_MODEL?: string;
  OPENAI_CALL_SUMMARY_MODEL?: string;
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;
  TWILIO_PHONE_NUMBER?: string;
  TWILIO_MEDIA_STREAM_URL?: string;
  TWILIO_PHONE_TRANSPORT?: string;
  TODO_PUBLIC_URL?: string;
  TODO_PROFILE_PHONE_KEY?: string;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

async function sourceFetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Requests received from the Cloudflare runtime expose immutable headers.
    // Access control strips spoofable actor headers and, for API tokens, adds a
    // trusted actor identity, so give that layer a mutable request copy.
    const routedRequest = new Request(request, { headers: new Headers(request.headers) });
    const url = new URL(routedRequest.url);

    if (url.pathname === "/talk" || url.pathname === "/talk/") return Response.redirect(new URL("/bots",url).toString(),303);
    if (/^\/api\/talk\/(?:threads(?:\/.*)?|history)\/?$/.test(url.pathname))
      return Response.json({ error: "Legacy Chat is retired. Use Bots for conversations and Operator for calls." }, { status: 410, headers: { "Cache-Control": "no-store" } });

    const phoneStreamResponse = await handleTalkPhoneStream(routedRequest, env);
    if (phoneStreamResponse) return phoneStreamResponse;

    const accessResponse = await appAccessResponse(routedRequest, env, ctx);
    if (accessResponse) return accessResponse;

    const installerResponse = await agentInstallerResponse(routedRequest, env);
    if (installerResponse) return installerResponse;

    if (url.pathname === "/api/sync/events" && request.method === "GET") return syncEventsResponse(routedRequest, env.DB);

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(routedRequest, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, routedRequest.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    return handler.fetch(routedRequest, env, ctx);

}

declare const __DAWAR_BUILD__:string;
function sourceWriterBinding(raw:string):SourceWriterBinding {
  const expected=JSON.parse(raw) as SourceWriterBinding;
  if(!/^[a-f0-9]{12}$/.test(__DAWAR_BUILD__) || expected.sourceId!==__DAWAR_BUILD__)throw Error('Original producer source differs.');
  return expected;
}

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Component-controller metadata has its own exact owner/capability check.
    // It must remain reachable before installation and during a held journal.
    if(new URL(request.url).pathname==='/api/migration/source/control')return applicationMigrationControlResponse(request,env,__DAWAR_BUILD__);
    if (!env.MIGRATION_SOURCE_WRITER_ADMISSION) return sourceFetch(request, env, ctx);
    try {
      const expected = sourceWriterBinding(env.MIGRATION_SOURCE_WRITER_ADMISSION);
      const url = new URL(request.url);
      // Fixed read-only migration handlers authenticate the exact owner and do
      // not update API-token use. Controller metadata cannot be journaled as an
      // ordinary writer once this original source is draining.
      if (request.method === 'GET' && ['/api/migration/identity','/api/migration/application'].includes(url.pathname)) return sourceFetch(request, env, ctx);
      const result = await runSourceWriterWork({db:env.DB,expected,kind:'worker-http',
        bodyPolicy:request.method === 'GET' && url.pathname === '/api/sync/events' ? 'read-only' : 'tracked',
        work:scope => sourceFetch(request, env, {waitUntil:p=>scope.waitUntil(p,task=>ctx.waitUntil(task)),passThroughOnException:()=>ctx.passThroughOnException()}),
      });
      ctx.waitUntil(result.settled);
      return result.value;
    } catch {
      return Response.json({error:'The original source is draining or its writer receipt could not be confirmed. Retain the original input.'},
        {status:503,headers:{'Cache-Control':'private, no-store'}});
    }
  },
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    const scheduledAt = new Date(controller.scheduledTime);
    console.info("[todo-maintenance] native scheduled event received", {
      cron: controller.cron,
      scheduledTime: scheduledAt.toISOString(),
    });
    if (!env.MIGRATION_SOURCE_WRITER_ADMISSION) {
      ctx.waitUntil(runTodoMinuteMaintenance(env, scheduledAt, "native-sites-cron"));
      return;
    }
    ctx.waitUntil(runSourceWriterWork({db:env.DB,expected:sourceWriterBinding(env.MIGRATION_SOURCE_WRITER_ADMISSION),kind:'worker-scheduled',
      work:()=>runTodoMinuteMaintenance(env, scheduledAt, "native-sites-cron"),
    }).then(result=>result.settled));
  },
};

export default worker;
