/**
 * Auto-load skills from shell rules
 *
 * Before the first model response, each rule runs its shell check in the
 * session working directory. An exit code of 0 loads that rule's skill into
 * the system prompt. This removes reliance on the model noticing a skill
 * description or on `AGENTS.md` telling it to load the skill.
 *
 * Rules live in RULES below. The check is any shell command; use stdout
 * redirection if it is noisy:
 *
 *   { skill: "git", when: "git rev-parse --show-toplevel >/dev/null 2>&1" }
 *
 * - Checks run once per session, then their skill blocks are cached.
 * - Skills are located through Pi's discovered commands and loaded from
 *   `SKILL.md` with frontmatter stripped.
 * - Unmatched rules inject nothing. `/skill:<name>` still works as the
 *   explicit way to load one.
 * - A matched skill that is missing or unreadable produces a warning and is
 *   skipped; the run continues without it.
 *
 * Usage:
 *   pi --extension ./extensions/auto-load-skills.ts
 */

import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { stripFrontmatter, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

interface Rule {
  /** Skill name as discovered by Pi. */
  skill: string;
  /** Shell condition; exit code 0 loads the skill. */
  when: string;
}

const RULES: readonly Rule[] = [
  { skill: "git", when: "git rev-parse --show-toplevel >/dev/null 2>&1" },
];

const SECTION = "auto_loaded_skills";

/** Cached for the session: undefined until prepared, otherwise the combined blocks or null. */
let skillBlocks: string | null | undefined;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function warn(ctx: ExtensionContext, message: string): void {
  ctx.ui.notify(message, "warning");
  if (!ctx.hasUI) {
    console.warn(message);
  }
}

function loadSkill(pi: ExtensionAPI, name: string): string {
  const command = pi.getCommands().find((item) => item.source === "skill" && item.name === `skill:${name}`);
  if (!command) {
    throw new Error(`auto-load-skills: skill "${name}" is not available; make sure Pi discovers a skill with that name.`);
  }

  const path = command.sourceInfo.path;
  const baseDir = command.sourceInfo.baseDir ?? dirname(path);
  try {
    const body = stripFrontmatter(readFileSync(path, "utf8")).trim();
    return `<skill name="${name}" location="${path}">\nReferences are relative to ${baseDir}.\n\n${body}\n</skill>`;
  } catch (err) {
    throw new Error(`auto-load-skills: cannot read skill file ${path}: ${errorMessage(err)}`);
  }
}

async function prepare(pi: ExtensionAPI, ctx: ExtensionContext): Promise<string | null> {
  if (skillBlocks !== undefined) {
    return skillBlocks;
  }

  const blocks: string[] = [];
  for (const rule of RULES) {
    const result = await pi.exec("bash", ["-c", rule.when], { cwd: ctx.cwd, timeout: 5000 });
    // pi.exec never rejects; spawn failures resolve with code 1. A timed-out
    // check is killed by a signal, which pi.exec reports as code 0.
    if (result.killed || result.code !== 0) {
      continue;
    }
    try {
      blocks.push(loadSkill(pi, rule.skill));
    } catch (err) {
      warn(ctx, errorMessage(err));
    }
  }
  skillBlocks = blocks.length > 0 ? blocks.join("\n\n") : null;
  return skillBlocks;
}

export default function (pi: ExtensionAPI): void {
  pi.on("session_start", () => {
    skillBlocks = undefined;
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const blocks = await prepare(pi, ctx);
    if (blocks) {
      // systemPromptOptions is mutable by design; no return value is needed.
      event.systemPromptOptions.sections[SECTION] = blocks;
    }
  });
}
