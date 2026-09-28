// Read-only, bounded reconciliation. Absence from a page is never rejection.
export async function findNativeTurn(runtime, threadId, { turnId, clientId, cursor = null }) {
  const seen = new Set();
  for (let pageIndex = 0; pageIndex < 4; pageIndex++) {
    const page = await runtime.historyPage(threadId, cursor, 25);
    const turn = page.data.find((entry) => (turnId && entry.id === turnId) ||
      (clientId && entry.items?.some((item) => item.type === "userMessage" && item.clientId === clientId)));
    if (turn) return { turn, nextCursor: null };
    const next = page.nextCursor ?? null;
    if (!next) return { turn: null, nextCursor: null };
    if (next === cursor || seen.has(next)) throw new Error("Native reconciliation cursor did not advance.");
    seen.add(next); cursor = next;
  }
  return { turn: null, nextCursor: cursor };
}
