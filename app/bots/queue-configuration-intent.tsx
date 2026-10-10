"use client";
import { useMemo,useSyncExternalStore } from 'react';
import type { Bot } from '../../lib/bots-types';
import type { ExecutionConfiguration } from '../../lib/bot-collaboration';
import type { BotComposer } from './composer-controller';
import { botsClient } from './client';
import { getComposerSettings } from './composer-settings-controller';
import { settingsText } from './configuration-evidence';
/** Queue intent is deliberately retained unsupported by this native adapter;
 * an active Send always retains the running turn's captured configuration. */
export function QueueConfigurationIntent({owner,bot,composer,configuration,online,refresh}:{owner:string;bot:Bot;composer:BotComposer;configuration:ExecutionConfiguration;online:boolean;refresh:()=>void}) {
  const controller=useMemo(()=>getComposerSettings(owner,bot.id),[owner,bot.id]);
  const state=useSyncExternalStore(controller.subscribe,controller.getSnapshot,controller.getSnapshot);
  const future=configuration.future;
  const active=configuration.active?.turnId===bot.activeTurnId?configuration.active:null;
  const displayed=controller.displayed(bot),snapshot=botsClient.snapshot;
  const resolved={model:displayed.model??snapshot?.defaults.model,effort:displayed.effort??snapshot?.defaults.effort??null,serviceTier:displayed.serviceTier??snapshot?.defaults.serviceTier,mode:displayed.mode??'default'};
  const confirmed=future.confirmation==='saved-for-next-turn'&&!state.pending&&!Object.keys(state.intent).length&&!state.error&&!state.storageError&&!state.confirmationError&&Object.keys(resolved).every(k=>resolved[k as keyof typeof resolved]===future.requested[k as keyof typeof resolved]);
  if(active?.requested&&(['model','effort','serviceTier','mode'] as const).every(k=>active.requested![k]===future.requested[k]))return null;
  const queue=()=>{
    const signature=composer.destinationSignature,settings={...future.requested,settingsRevision:future.revision};
    const current=()=>botsClient.owner===owner&&botsClient.snapshot?.bots.find(b=>b.id===bot.id)?.threadId===bot.threadId&&controller.getSnapshot()===state;
    // Revalidate server revision inside ordinary queue admission. The immutable
    // intent is stored before dispatch; recovery never reads newer selectors.
    void composer.send(true,false,null,signature,current,settings).then(refresh);
  };
  return <div className="bots-config-queue-intent"><p>Send guidance keeps the active turn&apos;s configuration. Next turn: {settingsText(future.requested)}.</p><button type="button" disabled={!online||!confirmed||!composer.ready||composer.committing||!!composer.operation||bot.queuePaused||!composer.draft.text.trim()&&!composer.draft.files.length} onClick={queue}>Queue with new settings</button><p>The current service retains this intended configuration as pending / unsupported; it will not silently dispatch using other settings.</p>{!confirmed&&<button type="button" disabled={!online} onClick={refresh}>Refresh confirmed settings</button>}</div>;
}
