import { join } from 'node:path';
import { LocalD1,privateDatabase } from './sqlite.mjs';
import { loadConfig } from './config.mjs';
import { ObjectStorage } from './object-storage.mjs';
import { images } from './images.mjs';
import { HubWriteAuthority,hubActivation } from './hub-authority.mjs';

let bindings;
function environment() {
  if (!bindings) {
    const c = loadConfig();
    if (c.mode === 'agent') throw Error('The agent has no application database.');
    // Only this local adapter opens the application DB. Control/native stores
    // have separate paths and no cross-machine shared SQLite filesystem.
    const writer=new HubWriteAuthority(privateDatabase(join(c.dataDirectory,'control.sqlite')),hubActivation(c));
    const objects=new ObjectStorage(c,{writer});
    bindings = { ...c.applicationEnvironment, DB:new LocalD1(join(c.dataDirectory,'application.sqlite'),{writer}),IMAGES:images,DAWAR_OBJECT_STORAGE:objects.adapter(),
      BOTS_OWNER_EMAIL:c.owner.key,BOTS_OWNER_USER_ID:c.owner.userId,TODO_PUBLIC_URL:c.publicOrigin,
      BOTS_RELAY_URL:`${c.publicOrigin.replace(/^https:/,'wss:')}/connect`,BOTS_MACHINE_ID:c.applicationEnvironment?.BOTS_MACHINE_ID??'dawar-vm',BOTS_TICKET_SECRET:c.gatewaySecret,
      TASK_REQUEST_SECRET:c.applicationEnvironment?.TASK_REQUEST_SECRET??c.applicationEnvironment?.BOTS_TICKET_SECRET??c.gatewaySecret };
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
