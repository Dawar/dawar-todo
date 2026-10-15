"use client";

import { useLayoutEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { Check, ListTodo, LoaderCircle, Zap } from "lucide-react";
import type { Bot, BotSnapshot } from "../../lib/bots-types";
import { botsClient } from "./client";
import { getComposerSettings, type Values, type ComposerSettingsController, type SettingsState } from "./composer-settings-controller";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { nextTurnSaveLabel } from "./next-turn-settings";
import { botProvider, providerDefaults, providerModels } from "../../lib/bot-provider";

function fastChoice(values: Values, snapshot: BotSnapshot, bot: Bot) {
  const defaults = providerDefaults(snapshot, bot);
  const model = providerModels(snapshot, bot).find(item => item.model === (values.model ?? defaults.model));
  const activeTier = values.serviceTier ?? defaults.serviceTier;
  const active = activeTier === "priority" || activeTier === "fast";
  const available = model?.serviceTiers.find(tier => tier.id === activeTier && active)?.id ??
    model?.serviceTiers.find(tier => tier.id === "priority" || tier.id === "fast")?.id;
  return { model, activeTier, active, available };
}

/** The controller keeps rapid intent and ordered saves across bot navigation. */
export function ComposerSettings({ bot, snapshot, online, context }: { bot: Bot; snapshot: BotSnapshot; online: boolean; context?: ReactNode }) {
  const owner = botsClient.owner;
  const controller = useMemo(() => getComposerSettings(owner, bot.id), [owner, bot.id]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useLayoutEffect(() => controller.observe(bot, snapshot, online), [controller, bot, snapshot, online]);
  useLayoutEffect(() => controller.attach(), [controller]);
  const effective = controller.displayed(bot);
  const { model, active, available } = fastChoice(effective, snapshot, bot);
  const models = providerModels(snapshot, bot), defaults = providerDefaults(snapshot, bot);
  const claude = botProvider(bot) === "claude";
  const pending = state.pending;
  const queued = Boolean(pending && Object.entries(state.intent).some(([field, value]) =>
    pending.values[field as keyof Values] !== value));
  const status = nextTurnSaveLabel(state, online);
  return <div className="bots-settings-wrap">
    <div className={`bots-settings-next-heading${status ? "" : " sr-only"}`}><strong>Next turn</strong><span role={pending ? "status" : undefined}>{pending && <LoaderCircle size={13} className={pending.phase === "saving" ? "bots-spin" : ""} aria-hidden="true" />}{status}{queued && <span className="sr-only">, latest choice queued</span>}</span></div>
    <div className="bots-settings" aria-label="Bot defaults for future turns" aria-busy={pending?.phase === "saving"}>
      <div className="bots-settings-selects">
        <label title="Model for future turns. A running turn keeps its own settings."><span className="sr-only">Model</span><NativeSelect aria-label="Model" disabled={!online}
          value={effective.model ?? ""} onChange={event => {
            const selected = models.find(item => item.model === event.target.value);
            const currentTier = controller.displayed(bot).serviceTier ?? defaults.serviceTier;
            const usableDefault = selected?.supportedReasoningEfforts.some(item => item.reasoningEffort === defaults.effort);
            const values = { model: event.target.value || null,
              effort: selected && !usableDefault ? selected.defaultReasoningEffort : null,
              ...(!claude && selected && currentTier !== "default" && !selected.serviceTiers.some(tier => tier.id === currentTier) ? { serviceTier: "default" } : {}) };
            controller.edit(values);
          }}>
          <option value="">Default · {defaults.model}</option>
          {models.map(item => <option key={item.id} value={item.model}>{item.displayName}</option>)}
        </NativeSelect></label>
        <label title="Reasoning effort for future turns. A running turn keeps its own settings."><span className="sr-only">Reasoning effort</span><NativeSelect aria-label="Reasoning effort" disabled={!online}
          value={effective.effort ?? ""} onChange={event => controller.edit({ effort: event.target.value || null })}>
          <option value="">Default · {defaults.effort}</option>
          {model?.supportedReasoningEfforts.map(item => <option key={item.reasoningEffort} value={item.reasoningEffort}>{item.reasoningEffort}</option>)}
        </NativeSelect></label>
      </div>
      <div className="bots-settings-toggles" role="group" aria-label="Reply mode and speed">
        <Button variant="ghost" type="button" aria-pressed={effective.mode === "plan"}
          disabled={!online} title="Plan"
          onClick={() => controller.edit({ mode: controller.displayed(bot).mode === "plan" ? "default" : "plan" })}>
          {effective.mode === "plan" ? <Check size={15} aria-hidden="true" /> : <ListTodo size={15} aria-hidden="true" />}Plan
        </Button>
        {!claude && <Button variant="ghost" type="button" aria-pressed={active}
          disabled={!online || !available && !active} title={!available && !active ? "Fast is unavailable for this model" : "Fast uses more Codex credits"}
          onClick={() => {
            const choice = fastChoice(controller.displayed(bot), snapshot, bot);
            controller.edit({ serviceTier: choice.active ? "default" : choice.available });
          }}>
          {active ? <Check size={15} aria-hidden="true" /> : <Zap size={15} aria-hidden="true" />}Fast
        </Button>}
      </div>
      {context}
    </div>
    <SettingsRecovery state={state} controller={controller} online={online} />
  </div>;
}

/** The same saved operation is recoverable wherever its settings are shown. */
export function SettingsRecovery({ state, controller, online }: { state: SettingsState; controller: ComposerSettingsController; online: boolean }) {
  const pending = state.pending;
  return (state.error || state.storageError || state.confirmationError || pending?.phase === "storage") && <div className="bots-settings-error" role="alert">
      <span>{state.storageError || state.error || state.confirmationError || "Saving is paused. Retry storage to continue with the same saved change."}</span>
      {(state.storageError || pending?.phase === "storage") &&
        <Button variant="ghost" type="button" disabled={!online} onClick={() => controller.retryStorage()}>Retry storage</Button>}
      {pending?.phase === "checking" &&
        <Button variant="ghost" type="button" disabled={!online || Boolean(state.storageError)} onClick={() => controller.retry()}>Retry saved change</Button>}
      {state.confirmationError && <Button variant="ghost" type="button" disabled={!online || state.refreshingConfirmation}
        onClick={() => controller.refreshConfirmed()}>{state.refreshingConfirmation ? "Refreshing…" : "Refresh settings"}</Button>}
    </div>;
}
