import type { GitHubPort } from "@titan-design/github";
import type { StepResult, StepRoute, WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import { stepIdMatches, type StepDeclaration } from "../definition.js";
import { codeRoute, step } from "../workflows/land.js";
import { failureOf } from "./error-class.js";

/**
 * Owner gates the owner approved every time they were asked (2026-10-05 to 10-19: D2 72/72, D7 63/63, D13 35/35), so each
 * now passes on its guard and leaves an audit record instead. Set a class to false to restore its owner gate (TP-3697).
 */
export interface GateDemotions {
  /** D2: a visual-path head or a gate-2-visual registration passes when `VISUAL_DEMOTION`'s guard holds at the head. */
  visual: boolean;
  /** D7: failed review rounds take a standing MERGE on infrastructure failures, else one fresh reviewer, before the owner. */
  failedRounds: boolean;
  /** D13: a red or unread main with no freeze path is an FYI line, never an acknowledge-only gate. */
  mainRed: boolean;
}

export const GATE_DEMOTIONS: GateDemotions = { visual: true, failedRounds: true, mainRed: true };

/** What a visual head must leave untouched, and which checks must be green at it, to merge without the owner. */
export interface VisualDemotion {
  /** Rendered and contrast baselines, and design tokens: any change to one is a rendered diff the owner reviews. */
  ownerPaths: string[];
  /** Checks that each need a green run at the head. */
  checks: string[];
  /** Checks run as shards named `<name> <i>/<n>`: every shard 1..n needs a green run at the head. */
  shardedChecks: string[];
}

export const VISUAL_DEMOTION: VisualDemotion = {
  ownerPaths: ["**/*.png", "**/*-snapshots/**", "**/*contrast*.json", "**/tokens/**", "**/*token*.*"],
  checks: ["visual"],
  shardedChecks: ["contrast"],
};

/** The D2 guard production decides with; `GATE_DEMOTIONS.visual` false restores every visual gate. */
export const DEFAULT_VISUAL_DEMOTION: VisualDemotion | null = GATE_DEMOTIONS.visual ? VISUAL_DEMOTION : null;

/** Marks an allow whose visual gate the D2 guard passed, so the evidence comment and the owner see what passed without them. */
export const VISUAL_DEMOTION_NOTE = "; auto-pass D2/visual-unchanged (TP-3697)";

const AUTO_PASS_RULES = ["D2/visual-unchanged", "D7/infra-standing-merge", "D7/fallback-reviewer", "D13/main-red-fyi"] as const;
type AutoPassRule = (typeof AUTO_PASS_RULES)[number];

const AUTO_PASS_STEP = "sh-auto-pass";
export const AUTO_PASS_STEPS: readonly StepDeclaration[] = [{ id: AUTO_PASS_STEP, kind: "dispatch" }];

const AutoPassInput = z.object({
  repo: z.string().min(1),
  pr: z.number().int().positive(),
  rule: z.enum(AUTO_PASS_RULES),
  headSha: z.string().min(1),
  /** Why the gate did not open, in the words the gate would have used. */
  detail: z.string(),
  /** The facts the rule read: shas, check names and conclusions, the verdict it stood on. */
  evidence: z.array(z.string()),
});
type AutoPassInput = z.infer<typeof AutoPassInput>;

const AutoPassResult = z.looseObject({
  ...{ rule: z.enum(AUTO_PASS_RULES), headSha: z.string(), detail: z.string(), evidence: z.array(z.string()) },
  ...{ commentId: z.number().nullable(), commentError: z.string().optional() },
});
type AutoPassRecord = z.infer<typeof AutoPassResult>;

const RULE_WORDS: Record<AutoPassRule, string> = {
  "D2/visual-unchanged": "visual change with no baseline or token change, its visual checks green and a MERGE at this head",
  "D7/infra-standing-merge": "review rounds failed on infrastructure only, and the run's MERGE at this head stands with CI green",
  "D7/fallback-reviewer": "review rounds failed, so a fresh reviewer goes first instead of the owner",
  "D13/main-red-fyi": "main CI is red or unread after this merge; FYI only, nothing waits on you",
};

const autoPassMarker = (rule: AutoPassRule, headSha: string): string => `<!-- shepherd-auto-pass:${rule}:${headSha} -->`;

export function autoPassComment(input: AutoPassInput): string {
  return [
    autoPassMarker(input.rule, input.headSha),
    `**Shepherd passed an owner gate** at \`${input.headSha.slice(0, 12)}\` under rule \`${input.rule}\`: ${RULE_WORDS[input.rule]}.`,
    "",
    input.detail,
    "",
    ...input.evidence.map((line) => `- ${line}`),
    "",
    "Rule source: `products/factory/src/shepherd/auto-pass.ts` (`GATE_DEMOTIONS`).",
  ].join("\n");
}

/** Never throws: a failed comment is recorded beside the rule, so the run goes on and the ledger still shows the pass. */
async function postAutoPass(port: GitHubPort, input: AutoPassInput): Promise<AutoPassRecord> {
  const record = { rule: input.rule, headSha: input.headSha, detail: input.detail, evidence: input.evidence };
  try {
    const comment = await port.upsertComment(input.repo, input.pr, autoPassMarker(input.rule, input.headSha), autoPassComment(input));
    return { ...record, commentId: comment.id };
  } catch (error) {
    return { ...record, commentId: null, commentError: failureOf(error) };
  }
}

export const autoPassRoute = (port: GitHubPort, now: () => number): StepRoute => codeRoute(AUTO_PASS_STEP, now, async (raw: unknown) => postAutoPass(port, AutoPassInput.parse(raw)));

/** One record per rule and head, so a replay returns the recorded pass and a second pass at the same head posts nothing new. */
export function recordAutoPass(ctx: WorkflowContext, input: AutoPassInput): Promise<AutoPassRecord> {
  return step(ctx, `${AUTO_PASS_STEP}:${input.rule.replace("/", "-")}:${input.headSha}`, input, AutoPassResult);
}

/** Owner gates a run passed on a demotion rule instead of opening, as the watch row and the owner digest show them. */
export const AutoPassedSchema = z.array(z.object({ rule: z.enum(AUTO_PASS_RULES), headSha: z.string(), detail: z.string(), at: z.string() }));
type AutoPassLine = z.infer<typeof AutoPassedSchema>[number];

/** The passes a run recorded, oldest first. */
export function autoPassesOf(steps: readonly StepResult[]): AutoPassLine[] {
  return steps.filter((result) => stepIdMatches(AUTO_PASS_STEP, result.stepId)).flatMap((result) => {
    const parsed = AutoPassResult.safeParse((result.data as { result?: unknown } | undefined)?.result);
    return parsed.success ? [{ rule: parsed.data.rule, headSha: parsed.data.headSha, detail: parsed.data.detail, at: result.completedAt }] : [];
  });
}

/** The watch row's `autoPassed` field, absent when the run passed no gate. */
export function autoPassField(steps: readonly StepResult[]): { autoPassed?: AutoPassLine[] } {
  const passed = autoPassesOf(steps);
  return passed.length > 0 ? { autoPassed: passed } : {};
}
