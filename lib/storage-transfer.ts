/** Retry only replayable storage transfers, with unchanged request identities.
 * Callers must not use this for messages, grants without IDs, or deletions. */
export async function replayableStorageFetch(transport:typeof fetch,input:RequestInfo|URL,init?:RequestInit) {
  for(let attempt=0;;attempt++) {
    init?.signal?.throwIfAborted();
    let response:Response;
    try { response=await transport(input,init); }
    catch(error) {
      if(attempt===2||init?.signal?.aborted)throw error;
      await new Promise(resolve=>setTimeout(resolve,200*(attempt+1)));continue;
    }
    if(attempt===2||![429,500,502,503,504].includes(response.status))return response;
    await response.body?.cancel().catch(()=>{});
    await new Promise(resolve=>setTimeout(resolve,200*(attempt+1)));
  }
}
