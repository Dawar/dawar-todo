import {AsyncLocalStorage} from 'node:async_hooks';
import {admitSourceWriter,settleSourceWriter} from './source-writer-admission.mjs';
const scopes=new AsyncLocalStorage();
const failure=()=>Error('Original source writer task lifetime could not be confirmed.');

// Factories register before effectful asynchronous work begins. A retained
// closed scope cannot start a later background task after its terminal receipt.
export function startSourceWriterTask(factory) {
  if(typeof factory!=='function')throw failure();
  const scope=scopes.getStore();return scope?scope.start(factory):Promise.resolve(factory());
}
class WriterScope {
  pending=new Set();closed=false;unknown=false;
  run(factory){if(this.closed)throw failure();return scopes.run(this,factory);}
  start(factory){if(this.closed)throw failure();return this.track(this.run(()=>Promise.resolve().then(factory)));}
  track(promise){
    if(this.closed||!promise||typeof promise.then!=='function')throw failure();
    if(this.pending.size>=1024)this.unknown=true;
    const task=Promise.resolve(promise).then(()=>{},()=>{this.unknown=true;});this.pending.add(task);
    void task.then(()=>this.pending.delete(task));return promise;
  }
  async finish() {
    while(true){await Promise.allSettled([...this.pending]);await Promise.resolve();if(!this.pending.size)break;}
    this.closed=true;return this.unknown?'unknown':'finished';
  }
  response(value,policy) {
    if(!(value instanceof Response))return value;
    if(value.webSocket||value.status===101){this.unknown=true;return value;}
    if(policy==='read-only'||!value.body)return value;
    const reader=value.body.getReader();let finish;
    const lifetime=new Promise(resolve=>{finish=resolve;});this.track(lifetime);
    let ended=false;
    const end=()=>{if(!ended){ended=true;reader.releaseLock();finish();}};
    const body=new ReadableStream({
      pull:async controller=> {
        try {const next=await this.run(()=>reader.read());if(next.done){end();controller.close();}else controller.enqueue(next.value);}
        catch(error){this.unknown=true;end();controller.error(error);}
      },
      cancel:async reason=> {
        this.unknown=true;
        try{await this.run(()=>reader.cancel(reason));}finally{end();}
      },
    });
    return new Response(body,{status:value.status,statusText:value.statusText,headers:value.headers});
  }
}
export async function runSourceWriterWork({db,expected,kind,operationId=crypto.randomUUID(),bodyPolicy='tracked',work}) {
  if(typeof work!=='function'||!['tracked','read-only'].includes(bodyPolicy))throw failure();
  expected=JSON.parse(JSON.stringify(expected));
  await admitSourceWriter({db,expected,kind,operationId}); // persist before work
  const scope=new WriterScope();
  const context={waitUntil(promise,platformWaitUntil){scope.track(promise);platformWaitUntil(promise);}};
  try {
    const value=scope.response(await scope.run(()=>work(context)),bodyPolicy);
    const settled=scope.finish().then(outcome=>settleSourceWriter({db,expected,kind,operationId,outcome}));
    return {value,settled,operationId};
  }catch(error) {
    scope.unknown=true;
    const outcome=await scope.finish();await settleSourceWriter({db,expected,kind,operationId,outcome});throw error;
  }
}
