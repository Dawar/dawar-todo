type Session={status:'unknown'|'signed-in'|'signed-out'|'offline';owner?:string;expiresAt?:number};
export const SESSION_EVENT='dawar-session-state';
export const SESSION_CHECK_EVENT='dawar-session-check';
let state:Session={status:'unknown'},pending:Promise<Session>|null=null,generation=0,active:AbortController|null=null;
let lastCheckedAt=0;
export const currentPortableSession=()=>state;
const publish=(value:Session)=>{state=value;window.dispatchEvent(new CustomEvent(SESSION_EVENT,{detail:value}));return value;};
export function invalidatePortableSession(){generation++;active?.abort();pending=null;return publish({status:'signed-out'});}
export function recheckPortableSession(){
  if(process.env.NEXT_PUBLIC_DAWAR_PORTABLE==='1'&&typeof window!=='undefined')window.dispatchEvent(new Event(SESSION_CHECK_EVENT));
}
export function portableSessionActivity(){if(Date.now()-lastCheckedAt>86400000)recheckPortableSession();}
export function checkPortableSession():Promise<Session>{
  if(pending)return pending;
  const controller=new AbortController(),captured=generation,timeout=setTimeout(()=>controller.abort(),5000);active=controller;
  const task:Promise<Session>=fetch('/api/auth/browser-session',{credentials:'same-origin',cache:'no-store',redirect:'error',signal:controller.signal}).then(async response=>{
    if(captured!==generation)return state;
    if(response.status===401)return publish({status:'signed-out'});
    if(!response.ok)return publish({status:'offline',owner:state.owner});
    const value=await response.json() as {owner?:unknown;expiresAt?:unknown};
    if(captured!==generation)return state;
    if(typeof value.owner!=='string'||!value.owner||typeof value.expiresAt!=='number')return publish({status:'offline',owner:state.owner});
    lastCheckedAt=Date.now();return publish({status:'signed-in',owner:value.owner,expiresAt:value.expiresAt});
  }).catch(()=>captured===generation?publish({status:'offline',owner:state.owner}):state).finally(()=>{clearTimeout(timeout);if(pending===task)pending=null;if(active===controller)active=null;});
  pending=task;return task;
}
