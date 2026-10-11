"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { LogOut } from "lucide-react";
import { signOutPortableSession } from "../../lib/portable-sign-out";

export function AccountSession() {
  const portable = process.env.NEXT_PUBLIC_DAWAR_PORTABLE === "1";
  const [owner, setOwner] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  useEffect(() => {
    if (!portable) return;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15_000);
    void fetch("/auth/session", { cache: "no-store", credentials: "same-origin", redirect: "error", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) return;
        const value = await response.json() as { owner?: string };
        if (!controller.signal.aborted && typeof value.owner === "string") setOwner(value.owner);
      }).catch(() => undefined).finally(() => window.clearTimeout(timeout));
    return () => { controller.abort(); window.clearTimeout(timeout); };
  }, [portable]);
  if (!portable) return null;
  const signOut = async () => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError("");
    try { await signOutPortableSession(); }
    catch (cause) { setError(cause instanceof Error && cause.name !== "TimeoutError" ? cause.message : "Sign out was not confirmed. Check your connection and try again."); }
    finally { inFlight.current = false; setBusy(false); }
  };
  return <Card role="region" aria-labelledby="account-session-title" className="mb-6 p-5 shadow-none sm:p-6">
    <div className="flex flex-wrap items-center justify-between gap-4">
      <div className="min-w-0 flex-1">
        <h2 id="account-session-title" className="text-lg font-semibold tracking-tight">Account</h2>
        {owner && <p className="mt-1 break-all text-sm text-muted-foreground">{owner}</p>}
        <p className="mt-2 text-sm leading-6 text-muted-foreground">Sign out on this browser. Your saved drafts and data stay available when you return.</p>
      </div>
      <Button type="button" variant="outline" onClick={() => void signOut()} disabled={busy} aria-busy={busy} className="shrink-0">
        <LogOut size={18} aria-hidden="true" />{busy ? "Signing out…" : "Sign out"}
      </Button>
    </div>
    {error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}
  </Card>;
}
