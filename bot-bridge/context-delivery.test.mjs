import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.mjs";
import { ContextDelivery, FULL_EVERY } from "./context-delivery.mjs";
import { PROFILE_SECTIONS, threadInstructions, BOT_INSTRUCTIONS } from "./profiles.mjs";
import { SECURE_INSTRUCTIONS } from "./secure-input-tools.mjs";
import { DIRECT_INSTRUCTIONS } from "./primary-execution.mjs";

const profile = (files, team = "Team: Alpha") => Object.defineProperty({
  botProfile: { kind: "application", value: "unused full text" },
  teamProfile: { kind: "application", value: team },
}, PROFILE_SECTIONS, { value: { header: "Current bot workspace instructions and memory (/bots/a):",
  sections: Object.entries(files).map(([key, text]) => ({ key, text: `## ${key}\n${text}` })) } });

async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), "delivery-"));
  const store = new Store(join(dir, "s.sqlite"));
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  return { store, delivery: new ContextDelivery({ store }), bot: { id: "bot-a", threadId: "thread-1", cwd: "/bots/a" } };
}

test("the first send carries every section; later sends carry only changes", async (t) => {
  const { delivery, bot } = await setup(t);
  const files = { "SOUL.md": "soul ".repeat(200), "MEMORY.md": "memory v1 ".repeat(200), "AGENTS.md": "agents ".repeat(200) };
  const first = delivery.prepare(bot, profile(files));
  assert.equal(first.full, true);
  for (const text of ["soul", "memory v1", "agents"]) assert.match(first.context.botProfile.value, new RegExp(text));
  assert.equal(first.context.teamProfile.value, "Team: Alpha");
  first.commit();

  const second = delivery.prepare(bot, profile(files));
  assert.equal(second.full, false);
  assert.doesNotMatch(second.context.botProfile.value, /soul|memory v1|agents/);
  assert.match(second.context.botProfile.value, /Unchanged since provided earlier in this conversation and still current: SOUL\.md, MEMORY\.md, AGENTS\.md\. Re-read them from \/bots\/a/);
  assert.match(second.context.teamProfile.value, /unchanged/);
  assert.ok(second.context.botProfile.value.length < first.context.botProfile.value.length);
  second.commit();

  const third = delivery.prepare(bot, profile({ ...files, "MEMORY.md": "memory v2" }, "Team: Alpha, renamed"));
  assert.match(third.context.botProfile.value, /## MEMORY\.md\nmemory v2$/);
  assert.doesNotMatch(third.context.botProfile.value, /## SOUL\.md/);
  assert.deepEqual(third.unchanged, ["SOUL.md", "AGENTS.md"]);
  assert.equal(third.context.teamProfile.value, "Team: Alpha, renamed");
});

test("nothing is assumed seen until a submission is acknowledged", async (t) => {
  const { delivery, bot } = await setup(t);
  const files = { "SOUL.md": "soul" };
  delivery.prepare(bot, profile(files)); // refused/failed: never committed
  assert.equal(delivery.prepare(bot, profile(files)).full, true);
});

test("a new thread, a compaction reset or the periodic refresh starts a new epoch", async (t) => {
  const { delivery, bot } = await setup(t);
  const files = { "SOUL.md": "soul" };
  delivery.prepare(bot, profile(files)).commit();
  assert.equal(delivery.prepare({ ...bot, threadId: "thread-2" }, profile(files)).full, true, "different thread");
  delivery.reset(bot.id);
  assert.equal(delivery.prepare(bot, profile(files)).full, true, "after compaction");
  delivery.prepare(bot, profile(files)).commit();
  for (let i = 1; i < FULL_EVERY; i++) delivery.prepare(bot, profile(files)).commit();
  assert.equal(delivery.prepare(bot, profile(files)).full, true, `refreshed after ${FULL_EVERY} sends`);
});

test("contexts without section metadata pass through untouched", async (t) => {
  const { delivery, bot } = await setup(t);
  const plain = { botProfile: { kind: "application", value: "x" } };
  assert.equal(delivery.prepare(bot, plain).context, plain);
});

test("thread instructions carry the standing policy once", () => {
  const bot = { id: "b", name: "B", cwd: "/bots/b", threadId: "t" };
  const text = threadInstructions(bot, { manager: true });
  assert.ok(text.startsWith(BOT_INSTRUCTIONS));
  assert.ok(text.includes(SECURE_INSTRUCTIONS) && text.includes(DIRECT_INSTRUCTIONS));
  assert.ok(!threadInstructions(bot).includes(DIRECT_INSTRUCTIONS));
});
