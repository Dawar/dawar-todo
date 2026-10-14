import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeProfile, profileContext, teamProfileContext } from "./profiles.mjs";
import { TEAM_INSTRUCTIONS, readTeam, teamReference } from "./teams.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "team-context-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const team = { id: `team-${"a".repeat(32)}`, name: "Shared", memory: "Verified first discovery", revision: 1 };
  const bot = { id: "bot", cwd: join(root, "bot"), name: "Member", teamId: team.id };
  const runtime = { root, store: { get: (kind, id) => kind === "team" && id === team.id ? team : null, bots: () => [bot] } };
  await initializeProfile(bot);
  return { root, team, bot, runtime };
}

test("team profile refreshes catalog and optional files without replacing personal memory", async t => {
  const { team, bot, runtime } = await fixture(t);
  await writeFile(join(bot.cwd, "MEMORY.md"), "Personal only");
  const first = await profileContext(bot, await teamReference(runtime, bot));
  assert.match(first.botProfile.value, /Personal only/);
  assert.doesNotMatch(first.botProfile.value, /Verified first discovery/);
  assert.match(first.teamProfile.value, /Verified first discovery/);
  assert.match(first.teamProfile.value, /important shared decisions/);
  const shared = await readTeam(runtime, team.id);
  await writeFile(join(shared.workspace, "TOOLS.md"), "Useful shared workflow");
  await writeFile(join(shared.workspace, "unrelated.txt"), "Do not inject arbitrary files");
  team.memory = "Verified newer discovery";
  team.revision++;
  const second = await profileContext(bot, await teamReference(runtime, bot));
  assert.match(second.teamProfile.value, /Verified newer discovery/);
  assert.match(second.teamProfile.value, /Useful shared workflow/);
  assert.doesNotMatch(second.teamProfile.value, /Verified first discovery|Do not inject arbitrary files/);
  assert.equal((await readFile(join(shared.workspace, "AGENTS.md"), "utf8")).includes(TEAM_INSTRUCTIONS), true);
  await writeFile(join(shared.workspace, "AGENTS.md"), "Human team guidance");
  await readTeam(runtime, team.id);
  assert.equal(await readFile(join(shared.workspace, "AGENTS.md"), "utf8"), "Human team guidance");
});

test("unassigned or deleted team supplies no stale team profile", async t => {
  const { bot, team, runtime } = await fixture(t);
  assert.equal(await teamReference(runtime, { ...bot, teamId: null }), null);
  team.deletedAt = "2026-10-01";
  assert.equal(await teamReference(runtime, bot), null);
  const context = await profileContext(bot, await teamReference(runtime, bot));
  assert.match(context.teamProfile.value, /No current team is assigned/);
  assert.doesNotMatch(context.teamProfile.value, /Verified first discovery/);
  assert.doesNotMatch(context.botProfile.value, /Shared team reference/);
});

test("team files reject symlinks, oversized files and nonregular files", async t => {
  const { root, bot, runtime } = await fixture(t);
  const reference = await teamReference(runtime, bot);
  const outside = join(root, "outside.md"), target = join(reference.workspace, "MEMORY.md");
  await writeFile(outside, "Other team's private data");
  await symlink(outside, target);
  await assert.rejects(teamProfileContext(reference), { code: "ELOOP" });
  await rm(target);
  await writeFile(target, "x".repeat(128 * 1024 + 1));
  await assert.rejects(teamProfileContext(reference), /under 128 KB/);
  await rm(target);
  await mkdir(target);
  await assert.rejects(teamProfileContext(reference), /regular file/);
});

test("team directory cannot point outside the shared root", async t => {
  const { root, bot, runtime } = await fixture(t);
  await mkdir(join(root, ".teams"));
  await mkdir(join(root, "elsewhere"));
  await symlink(join(root, "elsewhere"), join(root, ".teams", bot.teamId));
  await assert.rejects(teamReference(runtime, bot), /real directory inside/);
});
