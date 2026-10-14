export type BotAdminControl = { id: string; expectedRevision: number; specHash: string; decision: "approve" | "revoke" };
export type SavedBotAdminAction = { owner: string; botId: string; operationId: string; params: BotAdminControl };
const key = (owner: string, botId: string) => `dawar:bot:admin-control:${JSON.stringify([owner, botId])}`;
export function readBotAdminAction(owner: string, botId: string): SavedBotAdminAction | null {
  const raw = localStorage.getItem(key(owner, botId));
  if (!raw) return null;
  const a = JSON.parse(raw) as SavedBotAdminAction, p = a?.params;
  if (a?.owner !== owner || a.botId !== botId || typeof a.operationId !== "string" || !/^[a-zA-Z0-9:_-]{10,160}$/.test(a.operationId) || !p ||
      typeof p.id !== "string" || typeof p.specHash !== "string" || !/^[a-f0-9]{64}$/.test(p.specHash) || !Number.isSafeInteger(p.expectedRevision) || p.expectedRevision < 1 || !["approve", "revoke"].includes(p.decision))
    throw Error("A saved provisioning decision could not be read. Keep site storage for recovery.");
  return a;
}
export function saveBotAdminAction(a: SavedBotAdminAction) {
  if (readBotAdminAction(a.owner, a.botId)) throw Error("Reconcile the original saved decision first.");
  localStorage.setItem(key(a.owner, a.botId), JSON.stringify(a));
}
export function clearBotAdminAction(a: SavedBotAdminAction) {
  if (readBotAdminAction(a.owner, a.botId)?.operationId === a.operationId) localStorage.removeItem(key(a.owner, a.botId));
}
