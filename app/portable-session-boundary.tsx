"use client";

import { useEffect, useState, type ReactNode } from "react";
import { portableSignedOut, SIGNED_OUT_EVENT, SIGNED_OUT_KEY, SIGNED_OUT_PATH } from "../lib/portable-sign-out";
import { SignedOut } from "./signed-out";
import { taskSync } from "./task-sync";

export function PortableSessionBoundary({ children }: { children: ReactNode }) {
  const portable = process.env.NEXT_PUBLIC_DAWAR_PORTABLE === "1";
  const [ready, setReady] = useState(!portable);
  const [signedOut, setSignedOut] = useState(false);
  useEffect(() => {
    if (!portable) return;
    const leave = () => {
      taskSync.stop();
      setSignedOut(true);
      // Unload sockets and hidden Activity screens; never delete saved drafts.
      window.location.replace(SIGNED_OUT_PATH);
    };
    const check = () => { if (portableSignedOut()) leave(); };
    const storage = (event: StorageEvent) => { if (event.key === SIGNED_OUT_KEY && event.newValue) leave(); };
    const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(SIGNED_OUT_EVENT);
    if (channel) channel.onmessage = (event) => { if (event.data === "signed-out") leave(); };
    window.addEventListener(SIGNED_OUT_EVENT, leave);
    window.addEventListener("storage", storage);
    window.addEventListener("pageshow", check);
    window.addEventListener("focus", check);
    // Check before mounting any cached owner screen, including after Back.
    queueMicrotask(() => { setSignedOut(portableSignedOut()); setReady(true); });
    return () => {
      channel?.close();
      window.removeEventListener(SIGNED_OUT_EVENT, leave);
      window.removeEventListener("storage", storage);
      window.removeEventListener("pageshow", check);
      window.removeEventListener("focus", check);
    };
  }, [portable]);
  if (!ready) return <p role="status" className="p-6 text-sm text-[#69716c]">Opening…</p>;
  return signedOut ? <SignedOut /> : children;
}
