/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { appAccessResponse } from "./access";
import { runTodoMinuteMaintenance } from "../db/minute-maintenance";
import { handleTalkPhoneStream } from "./talk-phone-stream";

interface Env {
  ASSETS: Fetcher;
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

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Requests received from the Cloudflare runtime expose immutable headers.
    // Access control strips spoofable actor headers and, for API tokens, adds a
    // trusted actor identity, so give that layer a mutable request copy.
    const routedRequest = new Request(request, { headers: new Headers(request.headers) });
    const url = new URL(routedRequest.url);

    const phoneStreamResponse = await handleTalkPhoneStream(routedRequest, env);
    if (phoneStreamResponse) return phoneStreamResponse;

    const accessResponse = await appAccessResponse(routedRequest, env, ctx);
    if (accessResponse) return accessResponse;

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
  },
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    const scheduledAt = new Date(controller.scheduledTime);
    console.info("[todo-maintenance] native scheduled event received", {
      cron: controller.cron,
      scheduledTime: scheduledAt.toISOString(),
    });
    ctx.waitUntil(runTodoMinuteMaintenance(env, scheduledAt, "native-sites-cron"));
  },
};

export default worker;
