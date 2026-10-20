import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadDoctrine } from "./doctrine-load.js";
import type { DoctrineRegistry, DoctrineRule, DoctrineStage } from "./doctrine-schema.js";
import { sliceForStage } from "./doctrine-slice.js";
import { labelKey } from "./pace-items.js";
import { loadRuleRegistry, type RuleRegistry } from "./rules.js";
import type { SpineLedgerRow, SpineV1 } from "./spine-schema.js";

export type GuideStage = Extract<DoctrineStage, "plan" | "script">;

export const GUIDE_STAGES: readonly GuideStage[] = ["plan", "script"];

export interface GuideDeps {
  registry?: DoctrineRegistry;
  qRules?: RuleRegistry;
  /** Overrides the shipped `doctrine/guides` directory. */
  guidesDir?: string;
  /** A parsed story spine; its rows and ledger are appended per act. */
  spine?: SpineV1;
}

const DEFAULT_GUIDES_DIR = fileURLToPath(new URL("../doctrine/guides/", import.meta.url));

const readGuide = (dir: string, name: string): string => readFileSync(`${dir}/${name}`, "utf8").trimEnd();

const renderRule = ({ id, text }: DoctrineRule): string => `- **${id}**: ${text}`;

const renderLedgerRow = ({ item, kind, definedIn, reusedIn }: SpineLedgerRow): string =>
  `- ${item} (${kind}; defined in ${definedIn}${reusedIn.length > 0 ? `; reused in ${reusedIn.join(", ")}` : ""})`;

function renderRow(row: string, { journey, ledger }: SpineV1): string {
  const step = /^§3\.(\d+)$/.exec(row);
  const journeyRow = step ? journey.find((j) => j.n === Number(step[1])) : undefined;
  if (journeyRow) return `- ${row}: ${journeyRow.step}: ${journeyRow.what}`;
  const match = ledger.find((l) => labelKey(l.item) === labelKey(row));
  return match ? renderLedgerRow(match) : `- ${row}`;
}

/** Each act's (chapter's) covered spine rows, then the whole item ledger. */
function renderSpineActs(spine: SpineV1): string {
  const acts = spine.chapters.map(({ chapter, question, rows }) => [`### ${chapter}: ${question}`, ...rows.map((r) => renderRow(r, spine))].join("\n"));
  const ledger = `### Ledger\n${spine.ledger.map(renderLedgerRow).join("\n")}`;
  return `## Spine rows per act\n\n${[...acts, ledger].join("\n\n")}`;
}

/**
 * The planner's markdown guide for one stage: the intro, the prompt-safe rules of
 * `sliceForStage`, then the spine template. Code-enforced rules never appear, so no
 * threshold a lint checks can leak into a prompt.
 */
export function guidePlan(stage: GuideStage, deps: GuideDeps = {}): string {
  const { registry = loadDoctrine(), qRules = loadRuleRegistry(), guidesDir = DEFAULT_GUIDES_DIR, spine } = deps;
  const { prompt } = sliceForStage(registry, qRules, { stage });
  const rules = prompt.length > 0 ? prompt.map(renderRule).join("\n") : "- (none)";
  const parts = [readGuide(guidesDir, "planner-v0.md"), `## Rules for the ${stage} stage\n\n${rules}`, `## Spine template\n\n${readGuide(guidesDir, "spine-template.md")}`];
  if (spine) parts.push(renderSpineActs(spine));
  return parts.join("\n\n") + "\n";
}
