import type { Profile } from "../schema/profile.js";
import type { GeneratedFile } from "./types.js";
import { generateSkillFiles } from "./skill.js";
import { generateClaudeRules } from "./claude-rules.js";
import { generateHooksConfig } from "./hooks.js";
import { generateEslintExport } from "./eslint.js";
import { generateRuffExport } from "./ruff.js";
import { generateMarkdownExport } from "./markdown.js";
import { generateEditorConfigExport } from "./editorconfig.js";

export type ExportFormat =
  | "skill"
  | "claude-rules"
  | "hooks"
  | "eslint"
  | "ruff"
  | "markdown"
  | "editorconfig";

export const SUPPORTED_FORMATS: ExportFormat[] = [
  "skill",
  "claude-rules",
  "hooks",
  "eslint",
  "ruff",
  "markdown",
  "editorconfig",
];

export function exportProfile(
  profile: Profile,
  format: ExportFormat,
): GeneratedFile[] {
  switch (format) {
    case "skill":
      return generateSkillFiles(profile);

    case "claude-rules":
      return generateClaudeRules(profile);

    case "hooks": {
      const config = generateHooksConfig(profile);
      return [
        {
          path: ".claude/settings.json",
          content: JSON.stringify(config, null, 2),
        },
      ];
    }

    case "eslint":
      return [generateEslintExport(profile)];

    case "ruff":
      return [generateRuffExport(profile)];

    case "markdown":
      return [generateMarkdownExport(profile)];

    case "editorconfig":
      return [generateEditorConfigExport(profile)];

    default:
      throw new Error(
        `Unsupported export format: "${format as string}". Supported formats: ${SUPPORTED_FORMATS.join(", ")}`,
      );
  }
}
