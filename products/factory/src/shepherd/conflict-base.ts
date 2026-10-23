// superseded-at:M3 (D-M3-19: M3's lander owns conflict routing)
import type { GitHubPort, RepoSlug } from "@titan-design/github";
import type { StepRoute } from "@titan-design/workflow";
import { z } from "zod";
import { stepIdMatches, type StepDeclaration } from "../definition.js";
import { codeRoute, step, type CiSnapshot } from "../workflows/land.js";
import type { GateRun } from "./gates.js";
import type { ShepherdDeps } from "./phases.js";

const CONFLICT_BASE_STEP = "sh-conflict-base";
export const CONFLICT_BASE_STEPS: readonly StepDeclaration[] = [{ id: CONFLICT_BASE_STEP, kind: "dispatch" }];

interface ConflictBaseInput {
  repo: RepoSlug;
  headSha: string;
  baseRef?: string;
  /** The base sha read at the run's last conflict, if any. */
  lastBase?: string;
}

const ConflictBaseResult = z.looseObject({ baseSha: z.string().nullable(), containsLastBase: z.boolean() });
type ConflictBase = z.infer<typeof ConflictBaseResult>;

/** A failed read answers a null base, which `isNewConflict` reads as the same base, so the D9 demotion still applies. */
async function readConflictBase(port: Pick<GitHubPort, "defaultBranch" | "getHeadSha" | "compareAncestry">, input: ConflictBaseInput): Promise<ConflictBase> {
  try {
    const baseSha = await port.getHeadSha(input.repo, input.baseRef ?? (await port.defaultBranch(input.repo)));
    if (!baseSha || !input.lastBase || baseSha === input.lastBase) return { baseSha, containsLastBase: false };
    const ancestry = await port.compareAncestry(input.repo, input.lastBase, input.headSha);
    return { baseSha, containsLastBase: ancestry === "ahead" || ancestry === "identical" };
  } catch {
    return { baseSha: null, containsLastBase: false };
  }
}

/** New only when the base moved since the last conflict and the head already merged that last base: the fixer did its job. */
function isNewConflict(lastBase: string | undefined, read: ConflictBase): boolean {
  return lastBase !== undefined && read.baseSha !== null && read.baseSha !== lastBase && read.containsLastBase;
}

export function conflictBaseRoute(deps: Pick<ShepherdDeps, "port" | "now">): StepRoute {
  return codeRoute(CONFLICT_BASE_STEP, deps.now, (input: ConflictBaseInput) => readConflictBase(deps.port, input));
}

export interface ConflictBaseRun extends Pick<GateRun, "ctx" | "target"> {
  lastCi?: CiSnapshot;
  /** The base sha read at the last conflict; replaying the recorded step results rebuilds it. */
  conflictBase?: string;
  conflictBaseReads: number;
}

/**
 * TP-4098 (D2): a conflict against a base that moved past the fixer's last merge is a new conflict, not one that survived
 * the fixer. A run replaying history recorded before this step existed skips it and keeps the D9 count.
 */
export async function conflictAtNewBase(run: ConflictBaseRun, headSha: string): Promise<boolean> {
  const next = run.ctx.historyNext();
  if (next !== undefined && !stepIdMatches(CONFLICT_BASE_STEP, next)) return false;
  const lastBase = run.conflictBase;
  const input: ConflictBaseInput = { repo: run.target.repo, headSha, ...(run.lastCi?.baseRef && { baseRef: run.lastCi.baseRef }), ...(lastBase && { lastBase }) };
  const read = await step(run.ctx, `${CONFLICT_BASE_STEP}:${run.conflictBaseReads++}`, input, ConflictBaseResult);
  if (read.baseSha) run.conflictBase = read.baseSha;
  return isNewConflict(lastBase, read);
}
