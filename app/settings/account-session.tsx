"use client";

import { useEffect, useRef, useState } from "react";
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
  return <section aria-labelledby="account-session-title" className="mb-6 rounded-2xl border border-black/[0.07] bg-white p-5 shadow-sm sm:p-7">
    <div className="flex flex-wrap items-center justify-between gap-4">
      <div className="min-w-0 flex-1">
        <h2 id="account-session-title" className="text-lg font-semibold tracking-tight">Account</h2>
        {owner && <p className="mt-1 break-all text-sm text-[#69716c]">{owner}</p>}
        <p className="mt-2 text-sm leading-6 text-[#69716c]">Sign out on this browser. Your saved drafts and data stay available when you return.</p>
      </div>
      <button type="button" onClick={() => void signOut()} disabled={busy} className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-xl border border-[#216e4e]/20 bg-white px-4 py-2 text-sm font-semibold text-[#216e4e] hover:bg-[#edf5f0] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#216e4e] disabled:opacity-50">
        <LogOut size={18} aria-hidden="true" />{busy ? "Signing out…" : "Sign out"}
      </button>
    </div>
    {error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
  </section>;
}
