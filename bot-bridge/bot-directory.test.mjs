import test from "node:test";
import assert from "node:assert/strict";
import { messageDirectory, resolveRecipient } from "./bot-directory.mjs";

const bots = [
  { id: "connie-id", name: "Connie: Communications Manager", slug: "connie-communications-manager", threadId: "t1", extension: 9 },
  { id: "claudia-id", name: "Claudia: Lead Developer DawarTodo", slug: "claudia-lead-developer-dawartodo", threadId: "t2", extension: 33 },
  { id: "dwight-id", name: "Dwight: Lead Developer DawarTodo", slug: "dwight-lead-developer-dawartodo", threadId: "t3", extension: 2 },
  { id: "dwight-copy", name: "Dwight: Lead Developer (copy)", slug: "dwight-lead-developer-dawartodo-copy", threadId: "t4", extension: 30 },
  { id: "archived-id", name: "Ada", slug: "ada", threadId: "t5", archived: true },
  { id: "new-id", name: "Nova", slug: "nova", threadId: null },
];
const to = (ref) => resolveRecipient(bots, ref, "connie-id").id;

test("general references resolve to one bot", () => {
  for (const ref of ["Claudia", "claudia", "@Claudia", "  CLAUDIA ", "Claudia: Lead Developer DawarTodo", "claudia-lead-developer-dawartodo", "#33", "33", "claudia-id", "Clau"])
    assert.equal(to(ref), "claudia-id", ref);
  assert.equal(to("Dwight: Lead Developer DawarTodo"), "dwight-id", "an exact full name wins over a shared first word");
  assert.equal(to("#30"), "dwight-copy");
});

test("ambiguous, unknown, unavailable and self references are refused with guidance", () => {
  assert.throws(() => to("Dwight"), (e) => e.outcome === "rejected" && /matches several bots: .*Dwight: Lead Developer DawarTodo \(#2\).*Dwight: Lead Developer \(copy\) \(#30\)/.test(e.message));
  assert.throws(() => to("Lead"), /matches several bots/);
  assert.throws(() => to("Zelda"), /No active bot matches "Zelda".*directory/);
  assert.throws(() => to("Ada"), /No active bot/, "archived bots are not messageable");
  assert.throws(() => to("Nova"), /No active bot/, "unprovisioned bots are not messageable");
  assert.throws(() => to("Connie"), /That is this bot/);
  assert.throws(() => to(""), /Name the recipient/);
  assert.throws(() => to("x\u0000y"), /Name the recipient/);
});

test("the directory lists every active bot except the sender, by name", () => {
  assert.deepEqual(messageDirectory(bots, "connie-id").map((b) => [b.name, b.extension]),
    [["Claudia: Lead Developer DawarTodo", 33], ["Dwight: Lead Developer (copy)", 30], ["Dwight: Lead Developer DawarTodo", 2]]);
});
