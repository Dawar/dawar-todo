import type {SourceWriterBinding} from './source-writer-admission.mjs';
export function startSourceWriterTask<T>(factory:()=>T|Promise<T>):Promise<T>;
export function runSourceWriterWork<T>(input:{db:unknown;expected:SourceWriterBinding;kind:'worker-http'|'worker-scheduled';operationId?:string;bodyPolicy?:'tracked'|'read-only';work:(context:{waitUntil(promise:Promise<unknown>,platformWaitUntil:(p:Promise<unknown>)=>void):void})=>T|Promise<T>}):Promise<{value:T;settled:Promise<unknown>;operationId:string}>;
