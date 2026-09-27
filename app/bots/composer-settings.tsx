"use client";

import { useEffect, useRef, useState } from "react";
import { ListTodo, LoaderCircle, Zap } from "lucide-react";
import type { Bot, BotSnapshot } from "../../lib/bots-types";
import { botsClient, BotRpcError } from "./client";

type Setting = "model" | "effort" | "serviceTier" | "mode";
type Values = Pick<Bot, Setting>;
type Change = { field: Setting; values: Partial<Values>; operationId: string; afterCursor: number; phase: "saving" | "checking" };
type Confirmed = { values: Values; afterCursor: number };
const valuesOf = (bot: Bot): Values => ({ model: bot.model, effort: bot.effort, serviceTier: bot.serviceTier ?? null, mode: bot.mode });
const same = (a: Values, b: Values) => a.model === b.model && a.effort === b.effort &&
  (a.serviceTier ?? null) === (b.serviceTier ?? null) && a.mode === b.mode;

/** One settings transaction per bot. Native sends and durable drafts use their
 * own lanes; a snapshot cannot temporarily flip a pending toggle back. */
export function ComposerSettings({ bot, snapshot, online }: { bot: Bot; snapshot: BotSnapshot; online: boolean }) {
  const [change, setChange] = useState<Change | null>(null), [confirmed, setConfirmed] = useState<Confirmed | null>(null);
  const [error, setError] = useState("");
  const lock = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (confirmed && snapshot.cursor > confirmed.afterCursor && same(valuesOf(bot), confirmed.values))
      queueMicrotask(() => { if (mounted.current) setConfirmed(null); });
  }, [bot, confirmed, snapshot.cursor]);
  const effective = { ...valuesOf(bot), ...confirmed?.values, ...(change?.phase === "saving" ? change.values : {}) };
  const model = snapshot.models.find(item => item.model === (effective.model ?? snapshot.defaults.model));
  const activeTier = effective.serviceTier ?? snapshot.defaults.serviceTier;
  const fastActive = activeTier === "priority" || activeTier === "fast";
  const fastTier = model?.serviceTiers.find(tier => tier.id === activeTier && fastActive)?.id ??
    model?.serviceTiers.find(tier => tier.id === "priority" || tier.id === "fast")?.id;
  const activeTurn = Boolean(bot.activeTurnId);
  const pending = Boolean(change);
  function accepted(saved: Bot, owner: string, afterCursor: number) {
    if (!mounted.current || botsClient.owner !== owner) return;
    setConfirmed({ values: valuesOf(saved), afterCursor }); setChange(null); setError(""); lock.current = false;
    // The result confirms persistence; a fresh snapshot heals a missed event.
    void botsClient.refresh().catch(() => {});
  }
  async function update(field: Setting, values: Partial<Values>) {
    if (lock.current || !online) return;
    lock.current = true;
    const request: Change = { field, values, operationId: crypto.randomUUID(), afterCursor: snapshot.cursor, phase: "saving" };
    const owner = botsClient.owner;
    setError(""); setChange(request);
    try {
      const saved = await botsClient.rpc<Bot>("bots.update", bot.id, values, request.operationId, { owner });
      accepted(saved, owner, request.afterCursor);
    } catch (reason) {
      if (!mounted.current || botsClient.owner !== owner) return;
      if (reason instanceof BotRpcError && reason.outcome === "uncertain") {
        setChange({ ...request, phase: "checking" });
        setError("This setting has not been confirmed. Check its state before changing it again.");
      } else {
        setChange(null); lock.current = false;
        setError(reason instanceof Error ? reason.message : "The setting could not be saved.");
      }
    }
  }
  async function check() {
    if (!change || change.phase !== "checking" || !online) return;
    try {
      const fresh = await botsClient.refresh();
      const current = fresh.bots.find(item => item.id === bot.id);
      if (fresh.cursor > change.afterCursor && current && Object.entries(change.values).every(([field, value]) => current[field as Setting] === value)) {
        setChange(null); setConfirmed(null); setError(""); lock.current = false;
      } else setError("Still unconfirmed. Check again or try the same change when connected.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not check the setting."); }
  }
  async function retry() {
    if (!change || change.phase !== "checking" || !online) return;
    const owner = botsClient.owner, request = change;
    setChange({ ...request, phase: "saving" }); setError("");
    try { accepted(await botsClient.rpc<Bot>("bots.update", bot.id, request.values, request.operationId, { owner }), owner, request.afterCursor); }
    catch (reason) {
      if (!mounted.current || botsClient.owner !== owner) return;
      if (reason instanceof BotRpcError && reason.outcome === "uncertain") setChange(request);
      else { setChange(null); lock.current = false; }
      setError(reason instanceof Error ? reason.message : "The setting is still unconfirmed.");
    }
  }
  const disabled = !online || pending;
  return <div className="bots-settings-wrap">
    <div className="bots-settings" aria-label="Settings for this bot" aria-busy={change?.phase === "saving"}>
      <div className="bots-settings-selects">
        <label><span className="sr-only">Model</span><select aria-label="Model" disabled={disabled}
          value={effective.model ?? ""} onChange={event => {
            const selected = snapshot.models.find(item => item.model === event.target.value);
            const usableDefault = selected?.supportedReasoningEfforts.some(item => item.reasoningEffort === snapshot.defaults.effort);
            void update("model", { model: event.target.value || null,
              effort: selected && !usableDefault ? selected.defaultReasoningEffort : null,
              ...(selected && activeTier !== "default" && !selected.serviceTiers.some(tier => tier.id === activeTier) ? { serviceTier: "default" } : {}) });
          }}>
          <option value="">Default · {snapshot.defaults.model}</option>
          {snapshot.models.map(item => <option key={item.id} value={item.model}>{item.displayName}</option>)}
        </select></label>
        <label><span className="sr-only">Reasoning effort</span><select aria-label="Reasoning effort" disabled={disabled}
          value={effective.effort ?? ""} onChange={event => void update("effort", { effort: event.target.value || null })}>
          <option value="">Default · {snapshot.defaults.effort}</option>
          {model?.supportedReasoningEfforts.map(item => <option key={item.reasoningEffort} value={item.reasoningEffort}>{item.reasoningEffort}</option>)}
        </select></label>
      </div>
      <div className="bots-settings-toggles" role="group" aria-label="Reply mode and speed">
        <button type="button" className={effective.mode === "plan" ? "active" : ""} aria-pressed={effective.mode === "plan"}
          disabled={disabled} title={activeTurn ? "Applies to turns started after this saves; the current run keeps its settings" : "Plan the next reply"}
          onClick={() => void update("mode", { mode: effective.mode === "plan" ? "default" : "plan" })}>
          <ListTodo size={15} aria-hidden="true" />Plan
        </button>
        <button type="button" className={fastActive ? "active" : ""} aria-pressed={fastActive}
          disabled={disabled || !fastTier && !fastActive} title={!fastTier && !fastActive ? "Fast is unavailable for this model" : activeTurn ? "Applies to turns started after this saves; the current run keeps its settings" : "Fast uses more Codex credits"}
          onClick={() => void update("serviceTier", { serviceTier: fastActive ? "default" : fastTier })}>
          <Zap size={15} aria-hidden="true" />Fast
        </button>
      </div>
      <span className="bots-settings-progress" role={change?.phase === "saving" ? "status" : undefined}>
        {change?.phase === "saving" && <><LoaderCircle size={13} className="bots-spin" aria-hidden="true" /><span className="sr-only">Saving bot setting</span></>}
      </span>
      {activeTurn && <span className="bots-settings-scope">Future turns</span>}
    </div>
    {activeTurn && <span className="bots-settings-context">New turns after saving · This run keeps its settings.</span>}
    {error && <div className="bots-settings-error" role="alert"><span>{error}</span>{change?.phase === "checking" && <>
      <button type="button" disabled={!online} onClick={() => void check()}>Check setting</button>
      <button type="button" disabled={!online} onClick={() => void retry()}>Try again</button>
    </>}</div>}
  </div>;
}
