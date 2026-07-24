/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { appAccessResponse } from "./access";
import { processRecurringTodos } from "./recurring";
import { ensureTodoDatabase, wakeExpiredSnoozedTodosInDatabase } from "../db/todos";
import { dispatchTodoPushNotifications } from "../db/push-notifications";

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
    const url = new URL(request.url);

    const accessResponse = await appAccessResponse(request, env, ctx);
    if (accessResponse) return accessResponse;

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    return handler.fetch(request, env, ctx);
  },
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    const scheduledAt = new Date(controller.scheduledTime);
    console.info("[todo-recurring] scheduled event received", {
      cron: controller.cron,
      scheduledTime: scheduledAt.toISOString(),
    });
    ctx.waitUntil((async () => {
      await ensureTodoDatabase();
      try {
        await processRecurringTodos(env.DB, scheduledAt, { source: "scheduled" });
      } catch (error) {
        console.error("[todo-recurring] scheduled processing failed; continuing maintenance", { error });
      }
      try {
        const wokenIds = await wakeExpiredSnoozedTodosInDatabase(env.DB, scheduledAt);
        if (wokenIds.length) {
          console.info("[todo-push] scheduled snooze wake queued", {
            count: wokenIds.length,
            scheduledTime: scheduledAt.toISOString(),
          });
        }
      } catch (error) {
        console.error("[todo-push] scheduled snooze wake failed", { error });
      }
      try {
        await dispatchTodoPushNotifications(env.DB, env, scheduledAt);
      } catch (error) {
        console.error("[todo-push] scheduled batch dispatch failed", {
          scheduledTime: scheduledAt.toISOString(),
          error,
        });
      }
    })());
  },
};

export default worker;
