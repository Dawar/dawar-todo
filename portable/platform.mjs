import { join } from 'node:path';
import { LocalD1,privateDatabase } from './sqlite.mjs';
import { loadConfig } from './config.mjs';
import { ObjectStorage } from './object-storage.mjs';
import { images } from './images.mjs';
import { HubWriteAuthority,hubActivation } from './hub-authority.mjs';
import {operatorClient} from './operator-client.mjs';
import {createBrowserSession} from './browser-session.mjs';
import {statSync} from 'node:fs';

let bindings,configurationStamp,ownerIdentity,bindingsClose;
function environment() {
  // A separately supervised site must adopt the same stable private config
  // after a native deployment. Source changes cannot leave its cached writer
  // bound to the retired admission source. No timer or model turn is involved.
  const s=statSync(process.env.DAWAR_HUB_CONFIG,{bigint:true});
  const nextStamp=[s.dev,s.ino,s.size,s.mtimeNs].map(String).join(':');
  if (!bindings||nextStamp!==configurationStamp) {
    const c = loadConfig();
    if (c.mode === 'agent') throw Error('The agent has no application database.');
    const owner=JSON.stringify([c.owner.key,c.owner.userId,c.dataDirectory,c.publicOrigin]);
    if(ownerIdentity&&ownerIdentity!==owner)throw Error('Application owner or storage mapping changed; preserve the current site.');
    // Only this local adapter opens the application DB. Control/native stores
    // have separate paths and no cross-machine shared SQLite filesystem.
    const writer=new HubWriteAuthority(privateDatabase(join(c.dataDirectory,'control.sqlite')),hubActivation(c));
    const objects=new ObjectStorage(c,{writer});
    const DB=new LocalD1(join(c.dataDirectory,'application.sqlite'),{writer});
    const previousClose=bindingsClose;
    bindings = { ...c.applicationEnvironment, DB,IMAGES:images,DAWAR_OBJECT_STORAGE:objects.adapter(),
      BOTS_OWNER_EMAIL:c.owner.key,BOTS_OWNER_USER_ID:c.owner.userId,TODO_PUBLIC_URL:c.publicOrigin,BOTS_PUBLIC_ORIGIN:c.publicOrigin,
      BOTS_RELAY_URL:`${c.publicOrigin.replace(/^https:/,'wss:')}/connect`,BOTS_MACHINE_ID:c.applicationEnvironment?.BOTS_MACHINE_ID??'dawar-vm',BOTS_TICKET_SECRET:c.gatewaySecret,
      TASK_REQUEST_SECRET:c.applicationEnvironment?.TASK_REQUEST_SECRET??c.applicationEnvironment?.BOTS_TICKET_SECRET??c.gatewaySecret,
      DAWAR_OPERATOR_RPC:operatorClient(c),DAWAR_BROWSER_SESSION:createBrowserSession(c,writer) };
    configurationStamp=nextStamp;ownerIdentity=owner;
    bindingsClose=()=>{DB.close();objects.close();writer.close();writer.db.close();};
    // Old prepared operations retain their IDs and must fail their retired
    // source fence rather than obtaining a fresh write grant. Background work
    // is not cancelled or retried; its existing promises finish normally.
    if(previousClose)void Promise.allSettled([...background]).then(previousClose).catch(()=>console.error('[portable] Retired site binding cleanup needs inspection.'));
  }
  return bindings;
}
export const env = new Proxy({}, { get:(_,key) => environment()[key],has:(_,key) => key in environment() });
const background = new Set();
export function waitUntil(promise) {
  const task = Promise.resolve(promise); background.add(task);
  void task.catch(() => console.error('[portable] Background operation failed.')).finally(() => background.delete(task));
}
export async function settleBackground() { await Promise.allSettled([...background]); }
