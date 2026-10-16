"use client";
import { useProactive } from "./proactive-settings";
import { ProactiveBotView } from "./proactive-views";

/**
 * Bot details → Mind: this bot's inner monologue. Its switch, open loops and
 * journal of thoughts; mode, rhythm and every-bot status live on the
 * Proactive bots page (`onManage`).
 */
export function InitiativeSettings({ owner, botId, botName, online, onManage }: { owner: string; botId: string; botName: string; online: boolean; onManage: () => void }) {
  const { status, state, loading, read, configure, thinkNow } = useProactive(owner, botId, online);
  return <details className="bots-details-section" onToggle={event => { if (event.currentTarget.open) void read(); }}>
    <summary>Mind</summary>
    {!status ? <p role="status" className="bots-details-lead">{!online ? "Connect to see what this bot is thinking." : state.error || (loading ? "Loading…" : "Open to load.")}</p>
      : <ProactiveBotView status={status} botId={botId} botName={botName} state={state} disabled={!online}
        onConfigure={(patch, section) => void configure(patch as Record<string, unknown>, section)} onThinkNow={() => void thinkNow()} onManage={onManage} />}
  </details>;
}
