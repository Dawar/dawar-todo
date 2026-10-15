import { createHash } from "node:crypto";
import { PROFILE_SECTIONS } from "./profiles.mjs";
import { proposalContext } from "./initiative-node.mjs";

// Per-message profile context, sent once per conversation epoch.
//
// A direct send used to attach every profile file and the team context to
// each message, so a long conversation held one copy per message and every
// request re-read them all. Now the first send of an epoch carries the full
// text; later sends carry only sections whose exact text changed, plus one
// line naming the unchanged ones. A new thread, a context compaction (native
// or Claude), or FULL_EVERY sends start a new epoch. Hashes are committed only
// after the native start/steer was acknowledged, so a refused or failed
// submission never makes the bridge believe the model saw something.

const KIND = "profileDelivery";
export const FULL_EVERY = 40;
const sha = (text) => createHash("sha256").update(text).digest("hex");

export class ContextDelivery {
  constructor(runtime) { this.runtime = runtime; }
  get store() { return this.runtime.store; }
  current(bot) {
    const row = this.store.get(KIND, bot.id);
    return row?.threadId === bot.threadId && row.sends < FULL_EVERY ? row : null;
  }
  /** Start a new epoch: the next send carries everything again. */
  reset(botId) { this.store.remove(KIND, botId); }
  /**
   * Returns the context to send and a commit() for after acknowledgement.
   * Contexts without section metadata pass through unchanged.
   */
  prepare(bot, context) {
    // Initiative proposals the bridge delivered while the bot was idle were
    // never part of a model turn: the next send tells the bot what "it" said.
    const proposals = this.runtime.privateReviews?.unseen?.(bot) ?? [];
    const prepared = this.profile(bot, context);
    if (!proposals.length) return prepared;
    return { ...prepared, context: { ...prepared.context, initiativeProposals: { kind: "application", value: proposalContext(proposals) } },
      proposals: proposals.map((p) => p.id),
      commit: () => { prepared.commit(); this.runtime.privateReviews.markSeen(proposals.map((p) => p.id)); } };
  }
  profile(bot, context) {
    const meta = context?.[PROFILE_SECTIONS];
    if (!meta) return { context, commit: () => {} };
    const row = this.current(bot), seen = row?.hashes ?? {}, hashes = {};
    const changed = [], unchanged = [];
    for (const section of meta.sections) {
      hashes[section.key] = sha(section.text);
      (seen[section.key] === hashes[section.key] ? unchanged : changed).push(section);
    }
    const out = { ...context };
    const lines = [];
    if (unchanged.length)
      lines.push(`Unchanged since provided earlier in this conversation and still current: ${unchanged.map((s) => s.key).join(", ")}. Re-read them from ${bot.cwd} when you need their exact text.`);
    out.botProfile = { kind: "application", value: [meta.header, ...lines, ...changed.map((s) => s.text)].join("\n\n") };
    if (context.teamProfile) {
      hashes.teamProfile = sha(context.teamProfile.value);
      if (seen.teamProfile === hashes.teamProfile) {
        out.teamProfile = { kind: "application", value: "Team context is unchanged since provided earlier in this conversation and still current." };
        unchanged.push({ key: "teamProfile" });
      }
    }
    const full = !row;
    return {
      context: out,
      full,
      unchanged: unchanged.map((s) => s.key),
      commit: () => this.store.put(KIND, { id: bot.id, botId: bot.id, threadId: bot.threadId, hashes,
        sends: full ? 1 : row.sends + 1, updatedAt: new Date().toISOString() }),
    };
  }
}
