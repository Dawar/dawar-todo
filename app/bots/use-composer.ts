import { useEffect, useSyncExternalStore } from "react";
import { botComposers } from "./composer-service";

const serverSnapshot = () => 0;
export function useBotComposer(owner: string, botId: string | null) {
  useSyncExternalStore(botComposers.subscribe, botComposers.snapshot, serverSnapshot);
  useEffect(() => {
    botComposers.start();
    if (owner && botId) void botComposers.openComposer(owner, botId);
  }, [owner, botId]);
  // Synchronous identity lookup prevents even one render of another bot/owner.
  return { composer: botComposers.peek(owner, botId), error: botComposers.error };
}
