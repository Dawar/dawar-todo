import { desktopInstructions } from "./desktops.mjs";
import { mkdir, readFile, writeFile, lstat, realpath, open } from "node:fs/promises";
import { constants } from "node:fs";
import { join, relative, isAbsolute } from "node:path";
import { MANAGER_INSTRUCTIONS } from "./manager-tools.mjs";
import { DIRECT_INSTRUCTIONS } from "./primary-execution.mjs";
import { TEAM_INSTRUCTIONS } from "./teams.mjs";

export const PROFILE_FILES = [
  "SOUL.md",
  "IDENTITY.md",
  "USER.md",
  "MEMORY.md",
  "AGENTS.md",
  "TOOLS.md",
];
export const BOT_INSTRUCTIONS = `You are a persistent bot in Dawar Todo. Your working directory is your home workspace. Read SOUL.md, IDENTITY.md, USER.md, MEMORY.md, AGENTS.md, and TOOLS.md before beginning each task. These files define your identity, behavior, operational rules and durable knowledge. Keep factual memories useful and concise; never invent facts about the human. You can update these files when asked. Use the provided bots_schedule tools for scheduled work, bots_report_result for actionable scheduled results, and bots_publish_artifact to share files. Respond to explicit requests for future or recurring work by actually creating a schedule. Scheduled turns share this conversation. Scheduled prompts use ordinary conversation replies with Markdown and attachments. Follow any quiet-if-unchanged instruction in the schedule prompt. bots_report_result is optional for a separate actionable notification, not required to display a reply. Questions and failures are surfaced automatically. Your messages are shown in a chat interface. Do not claim access to desktop-only integrations unless they are available in your actual tool list.`;
export const RUN_INSTRUCTIONS = BOT_INSTRUCTIONS.replace("Scheduled turns share this conversation.",
  "This is an isolated scheduled execution. The human's main conversation is a separate native thread. Only the frozen schedule prompt, profile and explicitly forwarded context are available. Do not assume missing conversational context; ask a question in this run if necessary. Your questions, selected follow-ups and worker notices return here. Legacy profile text about sharing the main conversation describes older runs, not this execution.");
export function slugify(name) {
  return (
    name
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60)
      .replace(/-$/, "") || "bot"
  );
}
export function cleanName(value) {
  const name = String(value ?? "").trim();
  if (!name || name.length > 80 || /[\x00-\x1f]/.test(name))
    throw new Error("Choose a name between 1 and 80 characters.");
  return name;
}
export async function initializeProfile(bot) {
  await mkdir(bot.cwd, { recursive: true, mode: 0o700 });
  const templates = {
    "SOUL.md":
      "# Soul\n\nBe thoughtful, direct, resourceful, and honest about uncertainty. Follow the human’s instructions, explain meaningful decisions, and carry authorized work through to completion.\n",
    "IDENTITY.md": `# Identity\n\n- Name: ${bot.name}\n- Purpose: ${bot.purpose || "A persistent assistant for Dawar."}\n- Creator: Dawar\n`,
    "USER.md":
      "# User\n\nRecord only facts and preferences the human has shared.\n",
    "MEMORY.md": "# Memory\n\nStore useful, verified knowledge here.\n",
    "AGENTS.md": `# Operating instructions\n\n${BOT_INSTRUCTIONS}\n\n${DIRECT_INSTRUCTIONS}\n\nYour workspace is ${bot.cwd}. Keep deliverables here where practical. Never overwrite or delete another bot’s workspace without an explicit request.\n`,
    "TOOLS.md":
      "# Tools\n\nUse the tools exposed by your Codex session.\n\n- bots_schedule_list: inspect schedules and recent runs.\n- bots_schedule_save: create or update a one-time or recurring schedule.\n- bots_schedule_delete: cancel a schedule.\n- bots_report_result: notify Dawar of a meaningful finding during a scheduled run.\n- bots_publish_artifact: make a local file available to download in the conversation.\n\nFor native desktop UI tasks, use the bot_desktop MCP and read the bot-desktop-computer-use skill. It is bound to your own desktop and starts when you first take a screenshot.\n\nDo not place credentials in these files.\n",
  };
  for (const [file, text] of Object.entries(templates))
    await writeFile(join(bot.cwd, file), text, {
      flag: "wx",
      mode: 0o600,
    }).catch((e) => {
      if (e.code !== "EEXIST") throw e;
    });
}
export async function profileContext(bot, team = null) {
  const parts = [];
  for (const file of PROFILE_FILES) {
    const path = join(bot.cwd, file);
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 128 * 1024)
        throw new Error(`${file} must be a regular file under 128 KB.`);
      parts.push(`## ${file}\n${(await readFile(path, "utf8")).replace(MANAGER_INSTRUCTIONS, DIRECT_INSTRUCTIONS)}`);
    } catch (e) {
      if (e.code === "ENOENT")
        parts.push(
          `## ${file}\nMissing; ask the human before reconstructing personal facts.`,
        );
      else throw e;
    }
  }
  if (bot.threadId) parts.push(`## Desktop tools\n${desktopInstructions(bot)}`);
  if (team) parts.push(`## Shared team reference\nTeam: ${team.name}\nShared workspace: ${team.workspace}\nCurrent shared memory and team files are supplied in teamProfile. ${TEAM_INSTRUCTIONS}`);
  return {
    botProfile: {
      kind: "application",
      value: `Current bot workspace instructions and memory (${bot.cwd}):\n\n${parts.join("\n\n")}`,
    },
    ...await teamProfileContext(team),
  };
}
export async function teamProfileContext(team) {
  if (!team) return { teamProfile: { kind: "application", value:
    "No current team is assigned. Any previously supplied team context is historical, not current shared memory or membership." } };
  const directory = await lstat(team.workspace);
  if (!directory.isDirectory() || directory.isSymbolicLink() ||
      await realpath(team.workspace) !== team.workspace)
    throw new Error("Team workspace must be a real directory.");
  const parts = [`Team: ${team.name}\nTeam ID: ${team.id}\nRevision: ${team.revision}\nShared workspace: ${team.workspace}`,
    `## Shared memory writeback\n${TEAM_INSTRUCTIONS}`,
    `## Current team catalog memory\n${team.memory || "No shared memories saved yet."}`];
  for (const file of PROFILE_FILES) {
    let handle;
    try {
      handle = await open(join(team.workspace, file), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const info = await handle.stat();
      if (!info.isFile() || info.size > 128 * 1024)
        throw new Error(`Team ${file} must be a regular file under 128 KB.`);
      const content = await handle.readFile("utf8");
      if (Buffer.byteLength(content) > 128 * 1024)
        throw new Error(`Team ${file} must be under 128 KB.`);
      parts.push(`## Team ${file}\n${content}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    } finally {
      await handle?.close();
    }
  }
  return { teamProfile: { kind: "application", value: parts.join("\n\n") } };
}
export async function containedPath(root, path) {
  const realRoot = await realpath(root);
  const target = await realpath(path);
  const rel = relative(realRoot, target);
  if (rel.startsWith("..") || isAbsolute(rel))
    throw new Error("Path is outside the bot workspace.");
  return target;
}
