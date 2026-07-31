"use client";

import { useEffect } from "react";
import { getOrCreateDeviceId, headersWithDeviceId } from "./device-id";
import { ensureCurrentPushSubscription } from "./push-client";

async function refreshExistingPushSubscription(registration: ServiceWorkerRegistration) {
  if (!("Notification" in window) || Notification.permission !== "granted" || !registration.pushManager) return;
  const configResponse = await fetch("/api/push", {
    headers: headersWithDeviceId(),
    cache: "no-store",
  });
  if (!configResponse.ok) return;
  const config = await configResponse.json() as {
    configured: boolean;
    publicKey: string | null;
    subscription?: {
      active: boolean;
      failureCount: number;
      lastFailureStatus: number | null;
    } | null;
  };
  if (!config.configured || !config.publicKey) return;
  const unhealthy = Boolean(
    config.subscription
    && (!config.subscription.active || config.subscription.failureCount > 0),
  );
  const { subscription, renewed } = await ensureCurrentPushSubscription(
    registration,
    config.publicKey,
    { forceRenew: unhealthy },
  );
  const response = await fetch("/api/push", {
    method: "POST",
    headers: headersWithDeviceId({ "Content-Type": "application/json" }),
    body: JSON.stringify({ ...subscription.toJSON(), deviceId: getOrCreateDeviceId() }),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(payload.error || "Push subscription refresh failed.");
  }
  console.info("[todo-push] active device subscription refreshed on app launch", {
    renewed,
    repairedServerFailure: unhealthy,
  });
}

export function PwaRegister() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const localDevelopment = ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);
    if (localDevelopment) {
      void navigator.serviceWorker.getRegistrations().then((registrations) => Promise.all(
        registrations.map((registration) => registration.unregister()),
      )).then(() => caches.keys()).then((keys) => Promise.all(
        keys.filter((key) => key.startsWith("dawar-todo-shell-")).map((key) => caches.delete(key)),
      )).then(() => {
        console.info("[todo-pwa] local development service workers and app-shell caches cleared");
      }).catch((error) => {
        console.warn("[todo-pwa] local development service worker cleanup failed", error);
      });
      return;
    }
    const register = () => navigator.serviceWorker.register("/sw.js", { scope: "/" })
      .then((registration) => {
        console.info("[todo-pwa] service worker registered", { scope: registration.scope });
        void refreshExistingPushSubscription(registration).catch((error) => {
          console.warn("[todo-push] app-launch subscription refresh failed; scheduled delivery will retry", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
        return registration.update();
      })
      .catch((error) => console.error("[todo-pwa] service worker registration failed", error));
    if (document.readyState === "complete") void register();
    else window.addEventListener("load", register, { once: true });
    return () => window.removeEventListener("load", register);
  }, []);
  return null;
}
