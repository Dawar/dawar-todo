const MAX_REALTIME_ITEM_ID_LENGTH = 32;

function stableHash(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function realtimeConversationItemId(clientId: string) {
  const compact = clientId.replaceAll("-", "");
  if (/^[A-Za-z0-9_]{1,32}$/.test(compact)) return compact;

  const safePrefix = clientId.replace(/[^A-Za-z0-9_]/g, "").slice(0, 23) || "todo";
  return `${safePrefix}_${stableHash(clientId)}`.slice(0, MAX_REALTIME_ITEM_ID_LENGTH);
}
