import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadDoctrine } from "./doctrine-load.js";
import type { DoctrineRegistry, DoctrineRule, DoctrineStage } from "./doctrine-schema.js";
import { sliceForStage } from "./doctrine-slice.js";
import { loadRuleRegistry, type RuleRegistry } from "./rules.js";

export type GuideStage = Extract<DoctrineStage, "plan" | "script">;

export const GUIDE_STAGES: readonly GuideStage[] = ["plan", "script"];

export interface GuideDeps {
  registry?: DoctrineRegistry;
  qRules?: RuleRegistry;
  /** Overrides the shipped `doctrine/guides` directory. */
  guidesDir?: string;
}

const DEFAULT_GUIDES_DIR = fileURLToPath(new URL("../doctrine/guides/", import.meta.url));

const readGuide = (dir: string, name: string): string => readFileSync(`${dir}/${name}`, "utf8").trimEnd();

const renderRule = ({ id, text }: DoctrineRule): string => `- **${id}**: ${text}`;

/**
 * The planner's markdown guide for one stage: the intro, the prompt-safe rules of
 * `sliceForStage`, then the spine template. Code-enforced rules never appear, so no
 * threshold a lint checks can leak into a prompt.
 */
export function guidePlan(stage: GuideStage, deps: GuideDeps = {}): string {
  const { registry = loadDoctrine(), qRules = loadRuleRegistry(), guidesDir = DEFAULT_GUIDES_DIR } = deps;
  const { prompt } = sliceForStage(registry, qRules, { stage });
  const rules = prompt.length > 0 ? prompt.map(renderRule).join("\n") : "- (none)";
  return [readGuide(guidesDir, "planner-v0.md"), `## Rules for the ${stage} stage\n\n${rules}`, `## Spine template\n\n${readGuide(guidesDir, "spine-template.md")}`].join("\n\n") + "\n";
}
