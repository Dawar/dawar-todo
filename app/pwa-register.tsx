"use client";

import { useEffect } from "react";

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
        return registration.update();
      })
      .catch((error) => console.error("[todo-pwa] service worker registration failed", error));
    if (document.readyState === "complete") void register();
    else window.addEventListener("load", register, { once: true });
    return () => window.removeEventListener("load", register);
  }, []);
  return null;
}
