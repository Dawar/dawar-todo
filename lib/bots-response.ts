import type { BridgeFailureResult } from "./bots-types";

/** Certainty is protocol evidence, never inferred from a human-readable error. */
export function botFailureOutcome(message: Record<string, unknown>, result: unknown, operationId: string): "rejected" | "uncertain" {
  if (typeof message.error !== "string" || !message.error) return "uncertain";
  if (result === undefined) {
    // Compatibility with the first certainty-aware bridge/relay pair.
    return message.outcome === "rejected" ? "rejected" : "uncertain";
  }
  if (!result || typeof result !== "object" || Array.isArray(result) ||
      Object.keys(result).length !== 1 || !Object.hasOwn(result, "__dawarBotFailure")) return "uncertain";
  const metadata = (result as Partial<BridgeFailureResult>).__dawarBotFailure;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata) ||
      Object.keys(metadata).length !== 3 ||
      !["version", "operationId", "outcome"].every((key) => Object.hasOwn(metadata, key)) || metadata.version !== 1 ||
      typeof metadata.operationId !== "string" || metadata.operationId !== operationId ||
      !["rejected", "uncertain"].includes(metadata.outcome)) return "uncertain";
  // Old relays omit this field. When supplied, it must agree exactly; unknown
  // versions, malformed data and contradictory channels never retire an ID.
  if (Object.hasOwn(message, "outcome") && message.outcome !== metadata.outcome) return "uncertain";
  return metadata.outcome;
}
