export const SECURE_RESPONSE_BYTES = 1024 * 1024;
export const SECURE_RESPONSE_COUNT = 16;
export const SECURE_RESPONSE_TOTAL = 64 * 1024 * 1024;
export const SECURE_HTTPS_OPERATIONS = 256;

// Abort also bounds a stalled body reader. No private chunks escape this call.
export function secureAwait(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(Error('Private request cancelled.')); };
    if (signal.aborted) { Promise.resolve(promise).catch(() => {}); abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(value => { signal.removeEventListener('abort', abort); if (signal.aborted) reject(Error('Private request cancelled.')); else resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}
export async function secureResponseBytes(response, signal) {
  const reader = response.body?.getReader(), chunks = [];
  let size = 0, finished = false;
  try {
    if (reader) for (;;) {
      const { value, done } = await secureAwait(reader.read().then(result => { if (signal.aborted) result.value?.fill(0); return result; }), signal);
      if (done) { finished = true; break; }
      size += value.length;
      if (size > SECURE_RESPONSE_BYTES) { value.fill(0); return null; }
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } finally {
    for (const chunk of chunks) chunk.fill(0);
    if (reader && !finished) void reader.cancel().catch(() => {});
    try { reader?.releaseLock(); } catch { /* A cancelled read may still be settling. */ }
  }
}
