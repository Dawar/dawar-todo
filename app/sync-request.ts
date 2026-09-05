"use client";
import { headersWithDeviceId } from "./device-id";

export type RequestOptions = RequestInit & { timeoutMs?: number };

export function request<T>(path: string, options?: RequestOptions): Promise<T> {
  const formData = typeof FormData !== "undefined" && options?.body instanceof FormData;
  const headers = options?.body && !formData
    ? { "Content-Type": "application/json", ...(options.headers ?? {}) }
    : options?.headers;
  const controller = new AbortController();
  const timeoutMs = options?.timeoutMs ?? (formData ? 60_000 : 8_000);
  let timedOut = false;
  const timeout = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const upstreamAbort = () => controller.abort();
  const requestStartedAt = Date.now();
  if (options?.signal?.aborted) controller.abort();
  options?.signal?.addEventListener("abort", upstreamAbort, { once: true });
  return fetch(path, {
    ...options,
    signal: controller.signal,
    headers: options?.method && options.method !== "GET" ? headersWithDeviceId(headers) : headers,
  })
    .then(async (response) => {
      const jsonResponse = response.headers.get("content-type")?.includes("application/json");
      const payload = (jsonResponse ? await response.json() : {}) as T & { error?: string };
      if (response.ok && !jsonResponse) {
        const error = new Error("Please sign in again to continue syncing.") as Error & { status?: number };
        error.status = response.redirected ? 401 : 502;
        throw error;
      }
      if (!response.ok) {
        const error = new Error(payload.error || "Something went wrong.") as Error & { status?: number };
        error.status = response.status;
        throw error;
      }
      return payload;
    })
    .catch((error) => {
      if (!timedOut) {
        if (error instanceof Error) Object.assign(error, { requestStartedAt });
        throw error;
      }
      const timeoutError = new Error(`The connection did not respond within ${Math.round(timeoutMs / 1000)} seconds.`) as Error & {
        timeout?: boolean;
      };
      timeoutError.name = "TimeoutError";
      timeoutError.timeout = true;
      Object.assign(timeoutError, { requestStartedAt });
      throw timeoutError;
    })
    .finally(() => {
      window.clearTimeout(timeout);
      options?.signal?.removeEventListener("abort", upstreamAbort);
    });
}

export function retryableSyncError(error: unknown) {
  const status = (error as Error & { status?: number }).status;
  return status === 401 || status === 403
    || error instanceof TypeError
    || (error as Error & { timeout?: boolean }).timeout === true
    || (typeof status === "number" && (status === 408 || status === 425 || status === 429 || status >= 500))
    || status === undefined;
}

export function syncFailureKind(error: unknown): "transport" | "server" | "local" {
  const status = (error as Error & { status?: number }).status;
  if (error instanceof TypeError || (error as Error & { timeout?: boolean }).timeout === true) return "transport";
  if (typeof status === "number") return "server";
  return "local";
}

export function syncRetryDelay(attempts: number) {
  const base = Math.min(60_000, 1_000 * (2 ** Math.min(attempts, 6)));
  return base + Math.floor(Math.random() * Math.min(2_000, Math.round(base * 0.2)));
}

