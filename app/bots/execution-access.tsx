"use client";
import {useRef,useState} from 'react';
import {botsClient} from './client';

type Observation={executionAccess?:{configured?:{approvalPolicy?:string;sandbox?:string;networkAccess?:string};effective?:unknown}};
export function ExecutionAccess({owner,botId,online}:{owner:string;botId:string;online:boolean}){
  const sequence=useRef(0),[value,setValue]=useState<Observation|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  async function read(){
    if(!online||busy)return;const current=++sequence.current;setBusy(true);setError('');
    try{const result=await botsClient.rpc<Observation>('runtime.info',botId,{},undefined,{owner});if(sequence.current===current&&botsClient.owner===owner)setValue(result);}
    catch{if(sequence.current===current)setError('Reconnect to read execution access.');}
    finally{if(sequence.current===current)setBusy(false);}
  }
  const configured=value?.executionAccess?.configured;
  return <details className="bots-details-section" onToggle={event=>{if(event.currentTarget.open)void read();}}>
    <summary>Execution access</summary>
    {busy?<p className="bots-details-lead">Reading execution access…</p>:<>
      <p className="bots-details-lead">DawarTodo requests: {configured?.sandbox==='danger-full-access'&&configured.approvalPolicy==='never'?'Full access · no approvals':'Unknown'}.</p>
      <p className="bots-details-lead">Effective client mode: Unknown.</p>
    </>}
    {error&&<p role="status" className="bots-details-lead">{error}</p>}
  </details>;
}
