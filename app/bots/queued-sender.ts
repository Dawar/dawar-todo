import type { BotQueuedSubmission } from "../../lib/bots-types";
import type { SubmissionSource } from "../../lib/submission-source";

type Sender = { kind: "system"; id: string; name: string } | Extract<SubmissionSource, { kind: "bot" }>;
type Untrusted = { kind?: unknown; id?: unknown; name?: unknown; color?: unknown; avatar?: unknown };
const label = (value: unknown, max: number) => typeof value === "string" && value.trim() !== "" && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);

/**
 * The verified author of a queued message, from the application-owned source
 * linked by sourceSubmissionId. Human, legacy and unknown sources stay neutral:
 * item.source is routing metadata and message text is never identity.
 */
export function queuedSender(item: BotQueuedSubmission): Sender | null {
  const attribution = item.submission, source = attribution?.source as Untrusted | undefined;
  if (!attribution || !item.sourceSubmissionId || attribution.submissionId !== item.sourceSubmissionId || !source) return null;
  if (source.kind !== "bot" && source.kind !== "system" || !label(source.id, 512) || !label(source.name, 160)) return null;
  const id = source.id as string, name = source.name as string;
  if (source.kind === "system") return { kind: "system", id, name };
  return {
    kind: "bot", id, name,
    ...(typeof source.color === "string" && /^#[0-9a-f]{6}$/i.test(source.color) ? { color: source.color } : {}),
    ...(typeof source.avatar === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(source.avatar) ? { avatar: source.avatar } : {}),
  };
}
