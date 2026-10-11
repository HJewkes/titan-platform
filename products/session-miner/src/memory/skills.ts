import { readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SkillSummary } from "@titan-design/memory";
import { parse as parseYaml } from "yaml";

export function defaultSkillsRoots(): string[] {
  return [path.join(os.homedir(), ".claude", "skills")];
}

function readSkill(dir: string): SkillSummary | undefined {
  let raw: string;
  try {
    raw = readFileSync(path.join(dir, "SKILL.md"), "utf8");
  } catch {
    return undefined;
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  if (!match) return undefined;
  try {
    const fields = parseYaml(match[1] ?? "") as { name?: unknown; description?: unknown } | null;
    const name = typeof fields?.name === "string" ? fields.name : path.basename(dir);
    return typeof fields?.description === "string" ? { name, description: fields.description } : undefined;
  } catch {
    return undefined;
  }
}

function listSkillDirs(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => path.join(root, entry.name)).sort();
  } catch {
    return [];
  }
}

/** The name and description of each `<root>/<skill>/SKILL.md`; a skill without a readable description cannot be matched, so it is left out. */
export function readSkills(roots: readonly string[]): SkillSummary[] {
  return roots.flatMap(listSkillDirs).flatMap((dir) => readSkill(dir) ?? []);
}
