// Stop only a transport/native child after its caller's all-context idle proof.
// No signal escalation and no retry after an uncertain shutdown outcome.
export function closeIdleChild(child, { pending = 0, timeoutMs = 8000 } = {}) {
  if (!Number.isSafeInteger(pending) || pending !== 0) return Promise.reject(Error('Tool or native requests must finish before shutdown.'));
  if (!child || child.exitCode !== null && child.exitCode !== undefined || child.signalCode) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const finish = error => {
      clearTimeout(timer); child.removeListener('exit', exited); child.removeListener('error', failed);
      if (error) reject(error); else resolve();
    };
    const exited = () => finish();
    const failed = () => finish(Error('Idle child shutdown could not be confirmed. Inspect the original process.'));
    const timer = setTimeout(() => finish(Error('Idle child has not exited. No force or repeat is permitted.')), timeoutMs);
    child.once('exit', exited); child.once('error', failed);
    try { child.stdin?.end(); child.kill('SIGTERM'); } catch { failed(); }
  });
}
