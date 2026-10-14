export async function boundedJSON(response, maximum=128*1024) {
  const declared=response.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared)>maximum)) { await response.body?.cancel(); throw Error('Response exceeds its bound.'); }
  if (!response.body) throw Error('Response body is missing.');
  const reader=response.body.getReader(),chunks=[];let size=0;
  try {
    for (;;) {
      const {done,value}=await reader.read();if(done)break;
      size+=value.byteLength;if(size>maximum){await reader.cancel();throw Error('Response exceeds its bound.');}chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
