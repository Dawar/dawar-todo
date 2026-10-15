"use client";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { Bot } from "@/lib/bots-types";
import { IDLE_COMPACTION_LIMITS, compactionInFlight, compactionStatus, contextSummary, idleCompactionPolicy } from "@/lib/bot-context-compaction";
import { botsClient } from "./client";

/** Bot details → Settings: manual compaction plus the idle policy. */
export function ContextCompactionSettings({ bot, online, busy, supported, action }: {
  bot: Bot; online: boolean; busy: boolean; supported: boolean; action: (fn: () => Promise<unknown>) => Promise<unknown>;
}) {
  const policy = idleCompactionPolicy(bot), status = compactionStatus(bot), running = compactionInFlight(bot);
  const [tMin, tMax] = IDLE_COMPACTION_LIMITS.thresholdTokens, [mMin, mMax] = IDLE_COMPACTION_LIMITS.idleMinutes;
  if (!supported) return <section className="bots-details-section" aria-label="Context compaction">
    <h3>Context compaction</h3><p className="bots-details-lead">Compaction needs the updated bot service on this bot&apos;s machine.</p>
  </section>;
  return <section className="bots-details-section grid gap-2" aria-label="Context compaction">
    <h3>Context compaction</h3>
    <p className="bots-details-lead">{contextSummary(bot)}</p>
    {status && <p role="status" className="bots-details-lead">{status}</p>}
    <Button className="justify-self-start" variant="outline" type="button" disabled={!online || busy || running || Boolean(bot.activeTurnId)}
      onClick={() => void action(() => botsClient.rpc("thread.compact", bot.id))}><RotateCcw size={16} />{running ? "Compacting…" : "Compact conversation"}</Button>
    <form key={`${bot.id}:${policy.enabled}:${policy.thresholdTokens}:${policy.idleMinutes}`} className="grid gap-2" onSubmit={event => {
      event.preventDefault();
      const input = new FormData(event.currentTarget);
      void action(() => botsClient.rpc("bots.update", bot.id, { idleCompaction: { enabled: input.get("enabled") === "on",
        thresholdTokens: Number(input.get("thresholdK")) * 1000, idleMinutes: Number(input.get("idleMinutes")) } }));
    }}>
      <label className="flex items-center gap-2"><input type="checkbox" name="enabled" defaultChecked={policy.enabled} />Compact automatically when idle</label>
      <label>Context threshold (thousand tokens)<Input name="thresholdK" type="number" inputMode="numeric" required min={tMin / 1000} max={tMax / 1000} step={1} defaultValue={policy.thresholdTokens / 1000} /></label>
      <label>Idle minutes<Input name="idleMinutes" type="number" inputMode="numeric" required min={mMin} max={mMax} step={1} defaultValue={policy.idleMinutes} /></label>
      <Button className="justify-self-start" type="submit" disabled={!online || busy}>Save idle compaction</Button>
    </form>
  </section>;
}
