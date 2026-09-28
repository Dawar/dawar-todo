import type { BotEvent } from "../../lib/bots-types";
import type { HistoryPage } from "../../lib/bot-history-view";
import type { NativeEvent } from "./thread-state";
import { updateRunPage } from "./run-page-events";
import { runHistoryRefresh } from "./run-history-refresh";

/** Evidence lives for exactly one owned part/page/read, not one animation frame. */
export class RunPageRead {
  private events = new Map<number, BotEvent>();
  private bytes = 0;
  private overflow = false;
  constructor(readonly owner: string, readonly botId: string, readonly runId: string, readonly turnId: string | null,
    readonly identity: string, readonly generation: number, readonly append: boolean) {}
  record(event: BotEvent) {
    const data = event.data as { runId?: string; message?: NativeEvent };
    const refresh = runHistoryRefresh(event), part = refresh?.turnId ?? data.message?.params.turnId ?? data.message?.params.turn?.id;
    if (this.overflow || event.type !== "run.codex" && !refresh || event.botId !== this.botId || data.runId !== this.runId || this.turnId && part !== this.turnId || this.events.has(event.seq)) return;
    const bytes = new TextEncoder().encode(JSON.stringify(event)).length;
    if (this.events.size >= 64 || this.bytes + bytes > 256 * 1024) { this.overflow = true; this.events.clear(); this.bytes = 0; return; }
    this.events.set(event.seq, event); this.bytes += bytes;
  }
  reconcile(page: HistoryPage) {
    if (this.overflow) throw Error("This run changed too much while loading. Your open page is retained; refresh this part for its latest recorded state.");
    const turnId = this.turnId ?? page.turnIds?.[0] ?? page.entries[0]?.turnId;
    if (!turnId && this.events.size) throw Error("This run's part could not be matched to its updates. Refresh the recorded part.");
    return updateRunPage(page, [...this.events.values()].sort((a, b) => a.seq - b.seq), turnId, this.append);
  }
  release() { this.events.clear(); this.bytes = 0; }
}
