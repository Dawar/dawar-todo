"use client";

import { useEffect, useState, type ReactNode } from "react";
import { portableSignedOut, signOutChannel, SIGNED_OUT_EVENT, SIGNED_OUT_KEY, SIGNED_OUT_PATH } from "../lib/portable-sign-out";
import { ScreenLoading } from "./screen-feedback";
import { SignedOut } from "./signed-out";
import { taskSync } from "./task-sync";
import {checkPortableSession,SESSION_EVENT,SESSION_CHECK_EVENT,currentPortableSession} from '../lib/portable-session';

export function PortableSessionBoundary({ children }: { children: ReactNode }) {
  const portable = process.env.NEXT_PUBLIC_DAWAR_PORTABLE === "1";
  const [ready, setReady] = useState(!portable);
  const [signedOut, setSignedOut] = useState(false);
  const [unavailable,setUnavailable]=useState(false);
  useEffect(() => {
    if (!portable) return;
    let alive = true;
    const leave = () => {
      taskSync.stop();
      setSignedOut(true);
      // Unload sockets and hidden Activity screens; never delete saved drafts.
      window.location.replace(SIGNED_OUT_PATH);
    };
    const check = () => { if(portableSignedOut()){leave();return;}void checkPortableSession(); };
    const visible=()=>{if(document.visibilityState==='visible')check();};
    const session = () => {const value=currentPortableSession();if(value.status==='signed-out')leave();else setUnavailable(value.status==='offline');};
    const storage = (event: StorageEvent) => { if (event.key === SIGNED_OUT_KEY && event.newValue) leave(); };
    const channel = signOutChannel();
    if (channel) channel.onmessage = (event) => { if (event.data === "signed-out") leave(); };
    window.addEventListener(SIGNED_OUT_EVENT, leave);
    window.addEventListener("storage", storage);
    window.addEventListener("pageshow", check);
    window.addEventListener("focus", check);
    window.addEventListener('online',check);
    document.addEventListener('visibilitychange',visible);
    window.addEventListener(SESSION_EVENT,session);
    window.addEventListener(SESSION_CHECK_EVENT,check);
    // Check before mounting any cached owner screen, including after Back.
    queueMicrotask(() => { if (alive) { setSignedOut(portableSignedOut()); setReady(true);if(!portableSignedOut())check(); } });
    return () => {
      alive = false;
      channel?.close();
      window.removeEventListener(SIGNED_OUT_EVENT, leave);
      window.removeEventListener("storage", storage);
      window.removeEventListener("pageshow", check);
      window.removeEventListener("focus", check);
      window.removeEventListener('online',check);
      document.removeEventListener('visibilitychange',visible);
      window.removeEventListener(SESSION_EVENT,session);
      window.removeEventListener(SESSION_CHECK_EVENT,check);
    };
  }, [portable]);
  if (!ready) return <ScreenLoading />;
  return signedOut ? <SignedOut /> : <>{unavailable&&<div role="status" className="fixed inset-x-0 top-0 z-50 flex items-center justify-center gap-3 bg-foreground px-4 py-2 text-sm text-background"><span>Connection unavailable.</span><a className="underline" href="/auth/login?return_to=%2Fbots">Sign in</a></div>}{children}</>;
}
