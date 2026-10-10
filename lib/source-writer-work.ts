import {waitUntil as platformWaitUntil} from 'cloudflare:workers';
import {startSourceWriterTask} from '../portable/source-writer-scope.mjs';

// The thunk preserves ordinary platform behavior and, when original source
// admission is enabled, registers work before its effectful factory is invoked.
export function waitUntil(factory:()=>Promise<unknown>) {
  platformWaitUntil(startSourceWriterTask(factory));
}
