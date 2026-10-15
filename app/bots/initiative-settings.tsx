"use client";
import { useProactive } from "./proactive-settings";
import { ProactiveBotView } from "./proactive-views";

/**
 * Bot details → Settings: this bot's own proactive controls only. Mode,
 * pace, pilot bots and every-bot status live on the Proactive bots page
 * (`onManage`). Review traces stay private; only times and problems appear.
 */
export function InitiativeSettings({ owner, botId, botName, online, onManage }: { owner: string; botId: string; botName: string; online: boolean; onManage: () => void }) {
  const { status, state, loading, read, configure, thread } = useProactive(owner, botId, online);
  return <details className="bots-details-section" onToggle={event => { if (event.currentTarget.open) void read(); }}>
    <summary>Proactive</summary>
    {!status ? <p role="status" className="bots-details-lead">{!online ? "Connect to change proactive settings." : state.error || (loading ? "Loading…" : "Open to load.")}</p>
      : <ProactiveBotView status={status} botId={botId} botName={botName} state={state} disabled={!online}
        onConfigure={(patch, section) => void configure(patch as Record<string, unknown>, section)} onThread={(id, action) => void thread(id, action)} onManage={onManage} />}
  </details>;
}
