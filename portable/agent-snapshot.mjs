// A portable snapshot request names one assigned bot. Schedules and runs are
// authoritative on the hub and are already added by HubRpc.snapshot there;
// copying the node's entire historical catalog can exceed the transport cap.
export function agentSnapshot(snapshot, botId) {
  const scoped = field => (snapshot[field] ?? []).filter(row => row.botId === botId);
  return {
    ...snapshot,
    bots: (snapshot.bots ?? []).filter(bot => bot.id === botId),
    workByBot: scoped('workByBot'),
    pending: scoped('pending'),
    secureInputs: scoped('secureInputs'),
    activeScheduledTurns: scoped('activeScheduledTurns'),
    backgroundByBot: scoped('backgroundByBot'),
    backgroundRuns: scoped('backgroundRuns'),
    schedules: [],
    runs: [],
  };
}
