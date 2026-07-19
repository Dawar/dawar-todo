"use client";

import { useEffect } from "react";

export function PwaRegister() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
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
