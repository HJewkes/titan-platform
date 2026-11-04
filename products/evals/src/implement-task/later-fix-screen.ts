import type { Classification, Exec, FixProofPlan } from "@titan-design/fix-proof";
import { screenCase, screenVerdict, type HeadRuns } from "./screen.js";
import type { ImplementTaskSource } from "./write-case.js";

type LaterFixVerdict =
  | "attach"
  | "fix-no-tests"
  | "flaky"
  | "fails-on-corrected"
  | "passes-on-accepted"
  | "needs-new-api"
  | "not-collected"
  | "plan-mismatch"
  | `screen-error:${string}`;

const reproduces = (run: Classification): boolean => run.tests.some((test) => test.class === "reproduces");

/**
 * The primary screen's verdict, read for a later fix: base is the accepted merge and head the corrected reference.
 * The primary screen keeps a new-api test, but here the accepted merge already shipped the API, so a fix whose only
 * discriminating tests are new-api says nothing about the defect that escaped.
 */
export function laterFixVerdict(runs: HeadRuns): LaterFixVerdict {
  const verdict = screenVerdict(runs);
  if (verdict === "keep") return reproduces(runs[0]) ? "attach" : "needs-new-api";
  if (verdict === "fails-on-accepted") return "fails-on-corrected";
  if (verdict === "vacuous") return "passes-on-accepted";
  if (verdict === "no-hidden-tests") return "fix-no-tests";
  return verdict;
}

export interface LaterFixScreenInput {
  /** The kept case whose accepted merge is the screen's base. */
  source: ImplementTaskSource;
  fixPr: number;
  /** `buildCorrectedRef`'s sha: the accepted merge plus the fix's own diff. */
  correctedSha: string;
  /** `fixTests(...).tests`, which the screen's own plan of merge..corrected must reproduce. */
  tests: readonly string[];
  /** The scratch clone holding the corrected ref; the owner's clone does not have it. */
  clone: string;
  outDir: string;
  exec?: Exec;
  screen?: typeof screenCase;
}

const isScreenError = (verdict: string): verdict is `screen-error:${string}` => verdict.startsWith("screen-error:");

const sameTests = (plan: FixProofPlan, tests: readonly string[]): boolean => JSON.stringify([...plan.tests].sort()) === JSON.stringify([...tests].sort());

/** Runs TP-1144's flake screen with the accepted merge as base and the corrected reference as head, three head runs. */
export async function screenLaterFix(input: LaterFixScreenInput): Promise<LaterFixVerdict> {
  const screen = input.screen ?? screenCase;
  const source = { ...input.source, pr: input.fixPr, baseSha: input.source.mergeSha, mergeSha: input.correctedSha };
  let judged: { plan: FixProofPlan; runs: HeadRuns } | undefined;
  const onRuns = (plan: FixProofPlan, runs: HeadRuns): void => {
    judged = { plan, runs };
  };
  try {
    const verdict = await screen(source, { outDir: input.outDir, cloneFor: () => input.clone, exec: input.exec, onRuns });
    // Only a screen that failed before judging any run leaves `judged` unset.
    if (judged === undefined) return isScreenError(verdict) ? verdict : "screen-error:the screen judged no runs";
    // The screen plans from the corrected diff, which is the fix's diff only if it applied as written.
    if (!sameTests(judged.plan, input.tests)) return "plan-mismatch";
    return laterFixVerdict(judged.runs);
  } catch (error) {
    return `screen-error:${error instanceof Error ? error.message : String(error)}`;
  }
}
