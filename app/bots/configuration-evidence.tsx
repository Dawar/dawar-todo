"use client";
import type { TurnConfiguration,ExecutionSettings } from '../../lib/bot-collaboration';

export function settingsText(s:ExecutionSettings|null|undefined) {
  return s ? `${s.model} · ${s.effort ?? 'Unknown effort'} · ${s.mode==='plan'?'Plan':'Automatic'} · Fast ${s.serviceTier==='priority'||s.serviceTier==='fast'?'on':'off'}` : 'Unknown configuration';
}
export function ConfigurationEvidence({value,label='Turn configuration'}:{value:TurnConfiguration|null|undefined;label?:string}) {
  return <details className="bots-config-evidence"><summary>{label}: {settingsText(value?.requested)}{value?.requested && ' · Requested'}</summary><p>{value?.confirmation==='accepted-request'?'Native start acknowledged the requested settings; effective settings are not reported.':value?.requested?'Requested settings; native effective confirmation is unavailable.':'No configuration evidence was captured for this turn.'}</p>{value&&<small>Source: {value.source} {value.capturedAt&&`· Captured ${new Date(value.capturedAt).toLocaleString()}`}</small>}</details>;
}
