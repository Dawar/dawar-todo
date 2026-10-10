"use client";
import { useEffect,useState,useRef } from "react";
import { ActionIcon } from "../action-icon";
import { portableHeaders } from "../../lib/portable-csrf";
type Node = { id:string;fingerprint:string;online:boolean;revoked_at:number|null;hello:string };
type Download = { source:string;sha256:string;bytes:number;href:string };
export function ExecutionMachines(){
 const scope=useRef<string|null>(null),alive=useRef(false),action=useRef<AbortController|null>(null),fingerprintRef=useRef("");
 const [nodes,setNodes]=useState<Node[]>([]),[download,setDownload]=useState<Download|null>(null),[fingerprint,setFingerprint]=useState(""),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState("");
 useEffect(()=>{
  if(process.env.NEXT_PUBLIC_DAWAR_PORTABLE!=="1")return;alive.current=true;const c=new AbortController();
  void fetch("/auth/session",{cache:"no-store",signal:c.signal}).then(async r=>{if(!r.ok)throw Error("Sign in to set up a machine.");const v=await r.json() as {owner:string};if(c.signal.aborted)return;scope.current=v.owner;return fetch("/api/portable/installer",{cache:"no-store",signal:c.signal});}).then(async r=>{if(!r||!r.ok)throw Error("Installer is not available yet.");const d=await r.json() as Download;if(c.signal.aborted)return;if(d.href!=="/api/portable/installer/download"||!/^[a-f0-9]{64}$/.test(d.sha256))throw Error("Installer response was not confirmed.");setDownload(d);return fetch("/api/portable/nodes",{cache:"no-store",signal:c.signal});}).then(async r=>{if(!r||!r.ok)throw Error("Machine list could not be read.");if(!c.signal.aborted)setNodes((await r.json() as {nodes:Node[]}).nodes);}).catch(e=>{if(!c.signal.aborted)setError(e instanceof Error?e.message:"Machine setup unavailable.");});
  return()=>{alive.current=false;scope.current=null;action.current?.abort();c.abort();};
 },[]);
 if(process.env.NEXT_PUBLIC_DAWAR_PORTABLE!=="1")return null;
 async function pair(){
  if(busy||!confirmed||!/^[a-f0-9]{64}$/.test(fingerprint))return;setBusy(true);setError("");
  const capturedOwner=scope.current,capturedFingerprint=fingerprint,c=new AbortController();action.current=c;
  const current=()=>alive.current&&!c.signal.aborted&&scope.current===capturedOwner&&fingerprintRef.current===capturedFingerprint;
  try{if(!capturedOwner)throw Error('Owner session is not confirmed.');
   const sessionResponse=await fetch("/auth/session",{cache:"no-store",signal:c.signal});const session=await sessionResponse.json() as {owner?:string;csrf?:string};
   if(!sessionResponse.ok||session.owner!==capturedOwner||!current()||!session.csrf)throw Error("Owner session changed. Original pairing retained.");
   const key='dawar-pairing:'+capturedOwner,pendingText=localStorage.getItem(key),pending=pendingText?JSON.parse(pendingText) as {operationId:string;fingerprint:string}:null;
   if(pending&&pending.fingerprint!==fingerprint)throw Error('Reconcile the original machine pairing before changing its fingerprint.');
   const operationId=pending?.operationId??'pair:'+crypto.randomUUID();localStorage.setItem(key,JSON.stringify({operationId,fingerprint}));
   const r=await fetch("/api/portable/enrollment",{method:"POST",headers:portableHeaders({"content-type":"application/json","x-dawar-csrf":session.csrf}),body:JSON.stringify({fingerprint:capturedFingerprint,operationId}),signal:c.signal});const v=await r.json() as {token?:string;expiresAt?:number;error?:string};if(!current())return;
   if(!r.ok||!v.token||!v.expiresAt)throw Error(v.error??"Pairing was not confirmed. Refresh before requesting another file.");
   const finalSession=await fetch("/auth/session",{cache:"no-store",signal:c.signal});const finalOwner=await finalSession.json() as {owner?:string};if(!finalSession.ok||finalOwner.owner!==capturedOwner||!current())return;
   const url=URL.createObjectURL(new Blob([JSON.stringify({version:1,hubOrigin:location.origin,fingerprint,token:v.token,expiresAt:v.expiresAt})],{type:"application/json"}));const a=document.createElement("a");a.href=url;a.download="DawarTodo-pairing.json";a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);setConfirmed(false);
  }catch(e){if(current())setError(e instanceof Error?e.message:"Pairing outcome is unknown. Retain the original request.");}finally{if(action.current===c){action.current=null;if(alive.current)setBusy(false);}}
 }
 return <section aria-labelledby="execution-machines-title" className="mb-6 rounded-2xl border border-black/[0.07] bg-white p-5 sm:p-7">
  <h2 id="execution-machines-title" className="text-lg font-semibold">Execution machines</h2>
  <p className="mt-2 text-sm leading-6 text-[#69716c]">Run bots on your Mac or another Linux machine. Their workspaces and Codex sign-in stay on that machine.</p>
  {download?<><a className="mt-4 inline-flex min-h-11 items-center gap-2 rounded-xl bg-[#216e4e] px-4 text-sm font-semibold text-white" href={download.href} download><ActionIcon name="download"/>Download agent installer</a><p className="mt-2 break-all text-xs text-[#69716c]">SHA-256: {download.sha256}</p></>:<p className="mt-4 text-sm text-[#69716c]">The installer is being prepared.</p>}
  <ol className="mt-4 list-decimal space-y-2 pl-5 text-sm leading-6 text-[#69716c]"><li>Extract the download and run “Install DawarTodo Agent.command” on that machine.</li><li>Copy the fingerprint it displays into the field below.</li><li>Download the pairing file and give it to the installer within five minutes.</li></ol>
  <label className="mt-4 block text-sm font-semibold">Machine fingerprint<input value={fingerprint} disabled={busy} onChange={e=>{const v=e.target.value.trim().toLowerCase();fingerprintRef.current=v;setFingerprint(v);setConfirmed(false);}} maxLength={64} autoComplete="off" spellCheck={false} className="mt-2 w-full rounded-xl border border-black/10 px-3 py-3 font-mono text-xs" /></label>
  <label className="mt-3 flex gap-2 text-sm leading-6"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)} disabled={busy}/>I checked that this fingerprint matches the installer on my machine.</label>
  <button type="button" disabled={busy||!confirmed||!/^[a-f0-9]{64}$/.test(fingerprint)} onClick={()=>void pair()} className="mt-3 min-h-11 rounded-xl bg-[#216e4e] px-4 text-sm font-semibold text-white disabled:opacity-50">{busy?"Preparing…":"Download pairing file"}</button>
  {error&&<p role="alert" className="mt-3 text-sm text-[#9b3a2d]">{error}</p>}
  {nodes.length>0&&<ul className="mt-5 space-y-3">{nodes.map(n=><li key={n.id} className="min-w-0 rounded-xl bg-[#f1f6f3] p-3"><p className="text-sm font-semibold">{n.revoked_at?"Revoked":n.online?"Connected":"Offline"}</p><p className="break-all font-mono text-xs text-[#69716c]">{n.fingerprint}</p></li>)}</ul>}
 </section>;
}
