import type { Profile } from "../schema/profile.js";
import { extractAllRules } from "./template-helpers.js";
import type { GeneratedFile } from "./types.js";

function formatFrontmatter(globs: string[], description: string): string {
  return [
    "---",
    `description: "${description}"`,
    `globs: "${globs.join(", ")}"`,
    "alwaysApply: false",
    "---",
    "",
  ].join("\n");
}

function formatRuleLine(
  category: string,
  name: string,
  convention: unknown,
  description?: string,
): string {
  const value =
    typeof convention === "string"
      ? convention
      : JSON.stringify(convention);
  const desc = description ? ` -- ${description}` : "";
  return `- **${category}.${name}**: \`${value}\`${desc}`;
}

export function generateClaudeRules(profile: Profile): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  const allRules = extractAllRules(profile);
  const infoThreshold = profile.severityThresholds?.info ?? 0.40;

  const eligibleRules = allRules.filter(
    (r) => r.confidence >= infoThreshold,
  );

  if (eligibleRules.length > 0) {
    const frontmatter = formatFrontmatter(
      ["**/*.ts", "**/*.tsx"],
      `${profile.author}'s TypeScript coding style preferences`,
    );

    const body = [
      `# ${profile.author}'s TypeScript Style`,
      "",
      ...eligibleRules
        .sort((a, b) => b.confidence - a.confidence)
        .map((r) =>
          formatRuleLine(r.category, r.name, r.convention, r.description),
        ),
    ].join("\n");

    files.push({
      path: ".claude/rules/typescript.md",
      content: frontmatter + body + "\n",
    });
  }

  return files;
}
