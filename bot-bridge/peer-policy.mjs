// Measured units are accepted exchanges and UTF-8 selected-context bytes.
// No native token/cost/progress estimate is inferred from message prose.
export const PEER_POLICY_VERSION = 1;
export const PEER_LIMITS = Object.freeze({ contributions: 24, selectedBytes: 512 * 1024,
  trafficExchanges: 32, trafficWindowMs: 60_000, duplicateOccurrences: 3, duplicateWindowExchanges: 8 });
export const PEER_PAGE_LIMIT = 12;
export const PEER_PAGE_BYTES = 256 * 1024;
export const PEER_REASONS = Object.freeze({ 'legacy-limit': 'This discussion reached the previous lifetime limit. Continue to grant a fresh allowance.',
  'work-budget': 'The discussion used its current allowance of 24 new contributions.',
  'selected-bytes': 'The discussion used its current allowance of 512 KiB of selected text.',
  traffic: 'The discussion reached 32 exchanges within 60 seconds.',
  'repeated-context': 'The same selected text was repeated three times in the same direction within eight exchanges.',
  'owner-stopped': 'You stopped further discussion handoffs. Existing receipts and running work are retained.' });

export function initialPeerPolicy(root, usage, at) {
  if (root.policyVersion === PEER_POLICY_VERSION) return root;
  if(!Number.isSafeInteger(root.count)||root.count<0)throw Error('Discussion count is incomplete; original records were retained.');
  const count=root.count;
  const reason = count >= 12 ? 'legacy-limit' : usage.bytes >= PEER_LIMITS.selectedBytes ? 'selected-bytes' : null;
  return { ...root, count, policyVersion: PEER_POLICY_VERSION, revision: 1, state: reason ? 'paused' : 'active',
    reason, pausedAt: reason ? at : null, allowance: { number: 1, contributions: count,
      selectedBytes: usage.bytes, exchanges: usage.exchanges, startedAt: at }, recent: [], traffic: [],
    lifetimeBytes: usage.bytes, lifetimeExchanges: usage.exchanges };
}
export function peerPauseReason(root, evidence, at) {
  if (root.state !== 'active') return root.reason ?? 'owner-stopped';
  if (root.allowance.contributions + Number(evidence.charged) > PEER_LIMITS.contributions) return 'work-budget';
  if (root.allowance.selectedBytes + evidence.bytes > PEER_LIMITS.selectedBytes) return 'selected-bytes';
  if (root.traffic.filter(t => t > at - PEER_LIMITS.trafficWindowMs).length >= PEER_LIMITS.trafficExchanges) return 'traffic';
  const repeats = root.recent.slice(-(PEER_LIMITS.duplicateWindowExchanges - 1))
    .filter(e => e.hash === evidence.hash && e.sender === evidence.sender && e.recipient === evidence.recipient && e.kind === evidence.kind).length;
  return repeats >= PEER_LIMITS.duplicateOccurrences - 1 ? 'repeated-context' : null;
}
export function accountPeerExchange(root, evidence, at) {
  return { ...root, count: root.count + Number(evidence.charged), revision: root.revision + 1,
    allowance: { ...root.allowance, contributions: root.allowance.contributions + Number(evidence.charged),
      selectedBytes: root.allowance.selectedBytes + evidence.bytes, exchanges: root.allowance.exchanges + 1 },
    lifetimeBytes: root.lifetimeBytes + evidence.bytes, lifetimeExchanges: root.lifetimeExchanges + 1,
    recent: [...root.recent, { hash: evidence.hash, sender: evidence.sender, recipient: evidence.recipient, kind: evidence.kind }].slice(-PEER_LIMITS.duplicateWindowExchanges),
    traffic: [...root.traffic.filter(t => t > at - PEER_LIMITS.trafficWindowMs), at].slice(-PEER_LIMITS.trafficExchanges) };
}
export function pausePeerRoot(root, reason, at) {
  if (root.state !== 'active') return root;
  return { ...root, revision: root.revision + 1, state: 'paused', reason, pausedAt: at };
}
export function controlPeerRoot(root, action, at) {
  return action === 'stop' ? { ...root, revision: root.revision + 1, state: 'stopped', reason: 'owner-stopped', pausedAt: at } :
    { ...root, revision: root.revision + 1, state: 'active', reason: null, pausedAt: null,
      allowance: { number: root.allowance.number + 1, contributions: 0, selectedBytes: 0, exchanges: 0, startedAt: at }, recent: [], traffic: [] };
}
