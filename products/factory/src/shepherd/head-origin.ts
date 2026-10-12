import type { GitHubPort, RepoSlug } from "@titan-design/github";
import type { StepRoute } from "@titan-design/workflow";
import { z } from "zod";
import type { StepDeclaration } from "../definition.js";
import { codeRoute, step, type CiSnapshot } from "../workflows/land.js";
import type { CauseTrail } from "./review-cause.js";
import type { GateRun } from "./gates.js";
import type { ShepherdDeps } from "./phases.js";

export const HEAD_ORIGIN_STEP = "sh-head-origin";
export const HEAD_ORIGIN_STEPS: readonly StepDeclaration[] = [{ id: HEAD_ORIGIN_STEP, kind: "dispatch" }];

const HEAD_ORIGIN_KINDS = ["merge-of-base", "merge-other", "push", "unknown"] as const;

/** Fixed, so a failed read never copies a GitHub error into the ledger. */
export const UNREAD_ORIGIN = "the commit or compare read failed";

interface HeadOriginInput {
  repo: RepoSlug;
  /** The head the run read before this one. */
  fromHead: string;
  head: string;
  baseRef?: string;
}

const HeadOriginResult = z.looseObject({ head: z.string(), kind: z.enum(HEAD_ORIGIN_KINDS), reason: z.string().optional() });
type HeadOrigin = z.infer<typeof HeadOriginResult>;

/**
 * A merge of the base onto the previous head has that head as its first parent and a commit already on the base as
 * its second; a rebase-then-merge has some other first parent, so it reads `merge-other`.
 */
export async function classifyHead(port: Pick<GitHubPort, "getCommit" | "compareFiles">, input: HeadOriginInput): Promise<HeadOrigin> {
  try {
    const { parents } = await port.getCommit(input.repo, input.head);
    if (parents.length < 2) return { head: input.head, kind: "push" };
    if (parents.length > 2 || parents[0] !== input.fromHead || !input.baseRef) return { head: input.head, kind: "merge-other" };
    const compared = await port.compareFiles(input.repo, parents[1]!, input.baseRef);
    return { head: input.head, kind: compared.mergeBaseSha === parents[1] ? "merge-of-base" : "merge-other" };
  } catch {
    return { head: input.head, kind: "unknown", reason: UNREAD_ORIGIN };
  }
}

export function headOriginRoute(deps: Pick<ShepherdDeps, "port" | "now">): StepRoute {
  return codeRoute(HEAD_ORIGIN_STEP, deps.now, (input: HeadOriginInput) => classifyHead(deps.port, input));
}

/**
 * Observe-only: records once how a head Shepherd did not make came to be, so `shepherd stats` can count the base merges
 * other agents push. A run replaying history recorded before this step existed skips it, as the ledger has no row for it.
 */
export async function recordHeadOrigin(run: Pick<GateRun, "ctx" | "target"> & { lastCi?: CiSnapshot; trail: CauseTrail }, ci: CiSnapshot): Promise<void> {
  const fromHead = run.lastCi?.headSha;
  if (fromHead === undefined || fromHead === ci.headSha || run.trail.updated.has(ci.headSha)) return;
  const next = run.ctx.historyNext();
  if (next !== undefined && next !== HEAD_ORIGIN_STEP) return;
  const input: HeadOriginInput = { repo: run.target.repo, fromHead, head: ci.headSha, ...(ci.baseRef && { baseRef: ci.baseRef }) };
  await step(run.ctx, HEAD_ORIGIN_STEP, input, HeadOriginResult);
}
