import { requireTurn } from "./native-turn.mjs";

// Read-only, bounded reconciliation. Absence from a page is never rejection.
export async function findNativeTurn(runtime, threadId, { turnId, clientId, cursor = null, itemsView = "full" }) {
  if (!["full", "summary"].includes(itemsView)) throw new Error("Invalid native reconciliation view.");
  const seen = new Set();
  for (let pageIndex = 0; pageIndex < 4; pageIndex++) {
    // Queue acceptance needs the canonical user identity, never tool bodies.
    // Keep other callers' full-evidence contract and the shared admission bound.
    const page = itemsView === "summary" ? await runtime.historyReads.page(threadId, cursor, 25, "summary") :
      await runtime.historyPage(threadId, cursor, 25);
    const matchesClient = entry => entry.items?.some(item => item.type === "userMessage" && item.clientId === clientId);
    const matches = page.data.filter(entry => clientId ? matchesClient(entry) : turnId && entry.id === turnId);
    if (matches.length > 1 || matches[0] && turnId && matches[0].id !== turnId ||
        clientId && turnId && page.data.some(entry => entry.id === turnId && !matchesClient(entry)))
      throw new Error("Native reconciliation identities conflict. The original input remains unconfirmed.");
    const turn = matches[0];
    if (turn) return { turn: requireTurn(turn), nextCursor: null };
    const next = page.nextCursor ?? null;
    if (!next) return { turn: null, nextCursor: null };
    if (next === cursor || seen.has(next)) throw new Error("Native reconciliation cursor did not advance.");
    seen.add(next); cursor = next;
  }
  return { turn: null, nextCursor: cursor };
}
