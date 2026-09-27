"use client";

import { useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import { ListTodo, LoaderCircle, Zap } from "lucide-react";
import type { Bot, BotSnapshot } from "../../lib/bots-types";
import { botsClient } from "./client";
import { getComposerSettings, type Values } from "./composer-settings-controller";

function fastChoice(values: Values, snapshot: BotSnapshot) {
  const model = snapshot.models.find(item => item.model === (values.model ?? snapshot.defaults.model));
  const activeTier = values.serviceTier ?? snapshot.defaults.serviceTier;
  const active = activeTier === "priority" || activeTier === "fast";
  const available = model?.serviceTiers.find(tier => tier.id === activeTier && active)?.id ??
    model?.serviceTiers.find(tier => tier.id === "priority" || tier.id === "fast")?.id;
  return { model, activeTier, active, available };
}

/** The controller keeps rapid intent and ordered saves across bot navigation. */
export function ComposerSettings({ bot, snapshot, online }: { bot: Bot; snapshot: BotSnapshot; online: boolean }) {
  const owner = botsClient.owner;
  const controller = useMemo(() => getComposerSettings(owner, bot.id), [owner, bot.id]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useLayoutEffect(() => controller.observe(bot, snapshot, online), [controller, bot, snapshot, online]);
  const effective = controller.displayed(bot);
  const { model, active, available } = fastChoice(effective, snapshot);
  const activeTurn = Boolean(bot.activeTurnId);
  const pending = state.pending;
  const queued = Boolean(pending && Object.entries(state.intent).some(([field, value]) =>
    pending.values[field as keyof Values] !== value));
  const status = pending?.phase === "saving" ? "Saving" : pending?.phase === "storage" ? "Paused" : "Unconfirmed";
  return <div className="bots-settings-wrap">
    <div className="bots-settings" aria-label="Settings for this bot" aria-busy={pending?.phase === "saving"}>
      <div className="bots-settings-selects">
        <label><span className="sr-only">Model</span><select aria-label="Model" disabled={!online}
          value={effective.model ?? ""} onChange={event => {
            const selected = snapshot.models.find(item => item.model === event.target.value);
            const currentTier = controller.displayed(bot).serviceTier ?? snapshot.defaults.serviceTier;
            const usableDefault = selected?.supportedReasoningEfforts.some(item => item.reasoningEffort === snapshot.defaults.effort);
            controller.edit({ model: event.target.value || null,
              effort: selected && !usableDefault ? selected.defaultReasoningEffort : null,
              ...(selected && currentTier !== "default" && !selected.serviceTiers.some(tier => tier.id === currentTier) ? { serviceTier: "default" } : {}) });
          }}>
          <option value="">Default · {snapshot.defaults.model}</option>
          {snapshot.models.map(item => <option key={item.id} value={item.model}>{item.displayName}</option>)}
        </select></label>
        <label><span className="sr-only">Reasoning effort</span><select aria-label="Reasoning effort" disabled={!online}
          value={effective.effort ?? ""} onChange={event => controller.edit({ effort: event.target.value || null })}>
          <option value="">Default · {snapshot.defaults.effort}</option>
          {model?.supportedReasoningEfforts.map(item => <option key={item.reasoningEffort} value={item.reasoningEffort}>{item.reasoningEffort}</option>)}
        </select></label>
      </div>
      <div className="bots-settings-toggles" role="group" aria-label="Reply mode and speed">
        <button type="button" className={effective.mode === "plan" ? "active" : ""} aria-pressed={effective.mode === "plan"}
          disabled={!online} title={activeTurn ? "Applies to turns started after this saves; the current run keeps its settings" : "Plan the next reply"}
          onClick={() => controller.edit({ mode: controller.displayed(bot).mode === "plan" ? "default" : "plan" })}>
          <ListTodo size={15} aria-hidden="true" />Plan
        </button>
        <button type="button" className={active ? "active" : ""} aria-pressed={active}
          disabled={!online || !available && !active} title={!available && !active ? "Fast is unavailable for this model" : activeTurn ? "Applies to turns started after this saves; the current run keeps its settings" : "Fast uses more Codex credits"}
          onClick={() => {
            const choice = fastChoice(controller.displayed(bot), snapshot);
            controller.edit({ serviceTier: choice.active ? "default" : choice.available });
          }}>
          <Zap size={15} aria-hidden="true" />Fast
        </button>
      </div>
      <span className="bots-settings-progress" role={pending ? "status" : undefined}>
        {pending && <><LoaderCircle size={13} className={pending.phase === "saving" ? "bots-spin" : ""} aria-hidden="true" />{status}<span className="sr-only">{queued ? ", latest choice queued" : " bot setting"}</span></>}
      </span>
      {activeTurn && <span className="bots-settings-scope">Future turns</span>}
    </div>
    {activeTurn && <span className="bots-settings-context">New turns after saving · This run keeps its settings.</span>}
    {(state.error || state.storageError || pending?.phase === "storage") && <div className="bots-settings-error" role="alert">
      <span>{state.storageError || state.error || "Saving is paused. Retry storage to continue with the same saved change."}</span>
      {(state.storageError || pending?.phase === "storage") &&
        <button type="button" disabled={!online} onClick={() => controller.retryStorage()}>Retry storage</button>}
      {pending?.phase === "checking" &&
        <button type="button" disabled={!online || Boolean(state.storageError)} onClick={() => controller.retry()}>Retry saved change</button>}
    </div>}
  </div>;
}
