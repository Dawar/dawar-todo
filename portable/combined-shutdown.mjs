// The native owner refreshes its original claimed idle proof immediately before
// closing. Concurrent signals share one shutdown and cannot skip its proof.
export function combinedShutdown({ agent, gateway, health, child, siteTimer, stopping }) {
  let closing, effectsStarted = false;
  const close = async () => {
    await agent.runtime.maintenance.prepareShutdown();
    if (Object.values(agent.runtime.maintenance.counts()).some(n => n !== 0) ||
        agent.transport.pending.size || agent.transport.controlPending.size)
      throw Error('Portable shutdown requires reviewed all-context idle proof.');
    if(agent.runtime.maintenance.current&&agent.runtime.maintenance.current.phase!=='claimed')throw Error('The original restart claim was released.');
    agent.runtime.shutdownStarted=true;
    effectsStarted = true;
    await gateway.close();
    stopping();clearInterval(siteTimer);health.close();agent.transport.close();
    agent.runtime.usage.stop();agent.runtime.maintenance.close();agent.runtime.secure?.close();
    if (agent.runtime.codex.closeForShutdown) await agent.runtime.codex.closeForShutdown(); else agent.runtime.codex.close();
    await agent.runtime.desktops?.close();await agent.manager.close();
    agent.journal.close();agent.runtime.store.close();child?.kill('SIGTERM');
  };
  return () => closing ??= close().catch(error => { if (!effectsStarted) closing = null; throw error; });
}
