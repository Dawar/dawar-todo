"use client";
import type { Bot } from '../../lib/bots-types';
import type { TurnConfiguration,ExecutionConfiguration,ExecutionSettings } from '../../lib/bot-collaboration';
import { botsClient } from './client';
import { useCollaborationRead } from './collaboration-read';

export function settingsText(s:ExecutionSettings|null|undefined) {
  return s ? `${s.model} · ${s.effort ?? 'Unknown effort'} · ${s.mode==='plan'?'Plan':'Automatic'} · Fast ${s.serviceTier==='priority'||s.serviceTier==='fast'?'on':'off'}` : 'Unknown configuration';
}
export function ConfigurationEvidence({value,label='Turn configuration'}:{value:TurnConfiguration|null|undefined;label?:string}) {
  return <details className="bots-config-evidence"><summary>{label}: {settingsText(value?.requested)}{value?.requested && ' · Requested'}</summary><p>{value?.confirmation==='accepted-request'?'Native start acknowledged the requested settings; effective settings are not reported.':value?.requested?'Requested settings; native effective confirmation is unavailable.':'No configuration evidence was captured for this turn.'}</p>{value&&<small>Source: {value.source} {value.capturedAt&&`· Captured ${new Date(value.capturedAt).toLocaleString()}`}</small>}</details>;
}
export function useExecutionConfiguration(owner:string,bot:Bot|undefined,online:boolean) {
  const read=useCollaborationRead(owner,bot?.id??'', 'execution.config',{}, !!bot&&online&&botsClient.snapshot?.capabilities?.executionConfiguration===1,undefined,`foreground-thread:${bot?.threadId??'unbound'}`);
  const value=read.value;
  const valid=value?.version===1 && value.threadId===bot?.threadId && value.contextId===`foreground:${bot?.id}`;
  return {...read,value:valid?value:undefined};
}
export function WorkingConfiguration({value,activeTurnId,online}:{value?:ExecutionConfiguration;activeTurnId?:string|null;online:boolean}) {
  const active=value && value.active?.turnId===activeTurnId?value.active:null;
  return <div className="bots-working-config"><strong>Working now</strong>{!activeTurnId?<span>No confirmed active turn</span>:<ConfigurationEvidence value={active}/>} {!online&&<small>Offline · cached evidence</small>}{value&&<details><summary>Next turn · {value.future.confirmation.replaceAll('-',' ')}</summary><p>{settingsText(value.future.requested)}</p><p>{value.future.executionMode==='collaboration'?'Background collaboration mode':'Foreground conversation'} · {value.future.planIntent==='foreground-next-human-start'?'Plan next human start; consumed once':value.future.planIntent==='not-applicable'?'Foreground Plan intent does not apply here':'Automatic reply'}</p><small>Settings revision {value.future.revision}</small></details>}</div>;
}
