"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { botsClient } from "./client";
import type { Bot } from "../../lib/bots-types";
import { Button } from "@/components/ui/button";
import { ProactiveGlobalView, type ProactiveStatus, type SaveState, type ThreadAction } from "./proactive-views";

/** A snoozed loose thread comes back in a week. */
const snoozeUntil = () => new Date(Date.now() + 7 * 864e5).toISOString();
type Method = "initiative.read" | "initiative.configure" | "initiative.thread";

/**
 * Reads and changes proactive settings through any bot's scope (settings are
 * global; the hub needs a bot to authorize the owner). `section` names the
 * control being saved, for its Saving / Saved state.
 */
export function useProactive(owner: string, botId: string | null, online: boolean) {
  const sequence = useRef(0), savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [status, setStatus] = useState<ProactiveStatus | null>(null);
  const [state, setState] = useState<SaveState>({ saving: null, saved: null, error: "" });
  const [loading, setLoading] = useState(false);
  const run = useCallback(async (method: Method, params: Record<string, unknown>, section: string | null) => {
    if (!online || !botId) return;
    const current = ++sequence.current;
    if (section) setState({ saving: section, saved: null, error: "" }); else setLoading(true);
    try {
      const result = await botsClient.rpc<ProactiveStatus>(method, botId, params, undefined, { owner });
      if (sequence.current !== current || botsClient.owner !== owner) return;
      setStatus(result);
      setState({ saving: null, saved: section, error: "" });
      if (savedTimer.current) clearTimeout(savedTimer.current);
      if (section) savedTimer.current = setTimeout(() => setState(value => value.saved === section ? { ...value, saved: null } : value), 2500);
    } catch (error) {
      if (sequence.current === current) setState({ saving: null, saved: null, error: error instanceof Error ? error.message : "Proactive settings are unavailable right now." });
    } finally { if (sequence.current === current) setLoading(false); }
  }, [botId, online, owner]);
  useEffect(() => () => { if (savedTimer.current) clearTimeout(savedTimer.current); }, []);
  const read = useCallback(() => run("initiative.read", {}, null), [run]);
  const configure = useCallback((patch: Record<string, unknown>, section: string) =>
    run("initiative.configure", { patch, expectedRevision: status?.settings.revision ?? null }, section), [run, status?.settings.revision]);
  const thread = useCallback((itemId: string, action: ThreadAction) =>
    run("initiative.thread", { itemId, action, until: action === "snooze" ? snoozeUntil() : null }, "thread"), [run]);
  return { status, state, loading, read, configure, thread };
}

/** Full-page "Proactive bots" settings inside the bots workspace (?view=proactive). */
export function ProactiveSettingsPage({ owner, online, bots, onClose }: { owner: string; online: boolean; bots: Bot[]; onClose: () => void }) {
  const active = bots.filter(bot => !bot.archived), scopeBot = active[0]?.id ?? null;
  const { status, state, loading, read, configure, thread } = useProactive(owner, scopeBot, online);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  useEffect(() => { void read(); }, [read]);
  return <section className="bots-gallery" aria-label="Proactive bots">
    <header className="bots-gallery-heading">
      <Button variant="ghost" size="icon" onClick={onClose} aria-label="Back to bots"><ArrowLeft size={21} /></Button>
      <div><span>All bots</span><h1 tabIndex={-1} ref={heading}>Proactive bots</h1></div>
    </header>
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-4 py-5 sm:px-8 sm:py-7">
        {!scopeBot ? <p className="text-sm text-muted-foreground">Create a bot first; proactive settings apply to your bots.</p>
          : !status ? <p role="status" className="text-sm text-muted-foreground">{!online ? "Connect to change proactive settings." : state.error || (loading ? "Loading proactive settings…" : "")}</p>
          : <ProactiveGlobalView status={status} bots={active} state={state} disabled={!online} onConfigure={(patch, section) => void configure(patch, section)} onThread={(id, action) => void thread(id, action)} />}
      </div>
    </div>
  </section>;
}
