import { mkdir, readFile, writeFile, lstat, realpath } from "node:fs/promises";
import { resolve, join, relative, isAbsolute } from "node:path";

export const PROFILE_FILES = [
  "SOUL.md",
  "IDENTITY.md",
  "USER.md",
  "MEMORY.md",
  "AGENTS.md",
  "TOOLS.md",
];
export const BOT_INSTRUCTIONS = `You are a persistent bot in Dawar Todo. Your working directory is your home workspace. Read SOUL.md, IDENTITY.md, USER.md, MEMORY.md, AGENTS.md, and TOOLS.md before beginning each task. These files define your identity, behavior, operational rules and durable knowledge. Keep factual memories useful and concise; never invent facts about the human. You can update these files when asked. Use the provided bots_schedule tools for scheduled work, bots_report_result for actionable scheduled results, and bots_publish_artifact to share files. Respond to explicit requests for future or recurring work by actually creating a schedule. Scheduled turns share this conversation. Routine scheduled checks with no meaningful change should not notify the human. Use bots_report_result only for actionable findings. Questions and failures are surfaced automatically. Your messages are shown in a chat interface. Do not claim access to desktop-only integrations unless they are available in your actual tool list.`;
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
    "AGENTS.md": `# Operating instructions\n\n${BOT_INSTRUCTIONS}\n\nYour workspace is ${bot.cwd}. Keep deliverables here where practical. Never overwrite or delete another bot’s workspace without an explicit request.\n`,
    "TOOLS.md":
      "# Tools\n\nUse the tools exposed by your Codex session.\n\n- bots_schedule_list: inspect schedules and recent runs.\n- bots_schedule_save: create or update a one-time or recurring schedule.\n- bots_schedule_delete: cancel a schedule.\n- bots_report_result: notify Dawar of a meaningful finding during a scheduled run.\n- bots_publish_artifact: make a local file available to download in the conversation.\n\nDo not place credentials in these files.\n",
  };
  for (const [file, text] of Object.entries(templates))
    await writeFile(join(bot.cwd, file), text, {
      flag: "wx",
      mode: 0o600,
    }).catch((e) => {
      if (e.code !== "EEXIST") throw e;
    });
}
export async function profileContext(bot) {
  const parts = [];
  for (const file of PROFILE_FILES) {
    const path = join(bot.cwd, file);
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 128 * 1024)
        throw new Error(`${file} must be a regular file under 128 KB.`);
      parts.push(`## ${file}\n${await readFile(path, "utf8")}`);
    } catch (e) {
      if (e.code === "ENOENT")
        parts.push(
          `## ${file}\nMissing; ask the human before reconstructing personal facts.`,
        );
      else throw e;
    }
  }
  return {
    botProfile: {
      kind: "application",
      value: `Current bot workspace instructions and memory (${bot.cwd}):\n\n${parts.join("\n\n")}`,
    },
  };
}
export async function containedPath(root, path) {
  const realRoot = await realpath(root);
  const target = await realpath(path);
  const rel = relative(realRoot, target);
  if (rel.startsWith("..") || isAbsolute(rel))
    throw new Error("Path is outside the bot workspace.");
  return target;
}
