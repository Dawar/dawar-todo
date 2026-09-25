import type { Turn } from "../../lib/codex-protocol/v2/Turn";
import type { ThreadItem } from "../../lib/codex-protocol/v2/ThreadItem";

export type ConversationTurn = Turn & {
  diff?: string;
  planSteps?: { step: string; status: string }[];
};
export type NativeEvent = {
  method: string;
  params: {
    threadId?: string;
    turnId?: string;
    turn?: Turn;
    item?: ThreadItem;
    itemId?: string;
    delta?: string;
    summaryIndex?: number;
    text?: string;
    diff?: string;
    plan?: unknown;
  };
};
export function reduceBotTurns(
  turns: ConversationTurn[],
  event: NativeEvent,
): ConversationTurn[] {
  const p = event.params;
  if (event.method === "turn/started" && p.turn) {
    const previous = turns.find((t) => t.id === p.turn!.id);
    return [
      ...turns.filter((t) => t.id !== p.turn!.id),
      {
        ...previous,
        ...p.turn,
        items: p.turn.items.length ? p.turn.items : (previous?.items ?? []),
      },
    ];
  }
  const turnId = p.turnId ?? p.turn?.id;
  if (!turnId) return turns;
  const existing = turns.find((t) => t.id === turnId);
  let turn: ConversationTurn = existing ?? {
    id: turnId,
    items: [],
    itemsView: "full",
    status: "inProgress",
    error: null,
    startedAt: Date.now() / 1000,
    completedAt: null,
    durationMs: null,
  };
  if (event.method === "turn/completed" && p.turn)
    turn = {
      ...turn,
      ...p.turn,
      items: p.turn.items?.length ? p.turn.items : turn.items,
    };
  else if (
    (event.method === "item/started" || event.method === "item/completed") &&
    p.item
  ) {
    const index = turn.items.findIndex(
      (i) =>
        i.id === p.item!.id ||
        (i.type === "userMessage" &&
          p.item!.type === "userMessage" &&
          Boolean(i.clientId) &&
          i.clientId === p.item!.clientId),
    );
    const items = [...turn.items];
    if (index < 0) items.push(p.item);
    else items[index] = p.item;
    turn = { ...turn, items };
  } else if (event.method === "turn/diff/updated")
    turn = { ...turn, diff: p.diff };
  else if (event.method === "turn/plan/updated")
    turn = { ...turn, planSteps: p.plan as ConversationTurn["planSteps"] };
  else if (/(?:\/delta|Delta)$/.test(event.method) && p.itemId) {
    turn = {
      ...turn,
      items: turn.items.map((item) => {
        if (item.id !== p.itemId) return item;
        if (
          (item.type === "agentMessage" || item.type === "plan") &&
          "text" in item
        )
          return { ...item, text: item.text + (p.delta ?? "") };
        if (item.type === "commandExecution")
          return {
            ...item,
            aggregatedOutput: (item.aggregatedOutput ?? "") + (p.delta ?? ""),
          };
        if (
          item.type === "reasoning" &&
          event.method.includes("summaryTextDelta")
        ) {
          const summary = [...item.summary];
          const n = p.summaryIndex ?? 0;
          summary[n] = (summary[n] ?? "") + (p.delta ?? "");
          return { ...item, summary };
        }
        return item;
      }),
    };
  } else return turns;
  return existing
    ? turns.map((t) => (t.id === turnId ? turn : t))
    : [...turns, turn];
}
