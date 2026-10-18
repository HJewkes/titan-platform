import type { GitHubPort } from "@titan-design/github";
import { EXIT } from "@titan-design/registry";
import { z } from "zod";
import { RegistrationRefused, RequestedPolicyFields, resolveEffectivePolicy, type EffectivePolicy } from "./policy.js";
import { HEAD } from "./await-verdict.js";
import { isRepoKey, lookupSeat, type SeatBook } from "./seats.js";
import type { KindMove } from "./register-kind.js";
import { TASK_KINDS, type Registration } from "./store.js";

export const coded = (message: string, code: number): Error => Object.assign(new Error(message), { code });

export const RepoArg = z.string().refine(isRepoKey, "must be owner/repo");
export const PrArg = z.number().int().positive();
/** Git's ref-name rules, loosely: no whitespace, control characters or the characters git reserves. */
const BranchArg = z.string().regex(/^[^\s~^:?*[\\\p{Cc}]+$/u, "must be a branch name");

export const RegisterArgs = z
  .object({
    repo: RepoArg,
    pr: PrArg.optional(),
    branch: BranchArg.optional(),
    head: z.string().regex(HEAD, "must be 40 lowercase hex characters").optional(),
    base: BranchArg.optional(),
    task: z.string().min(1),
    implementer: z.string().min(1),
    reviewer: z.string().min(1).optional(),
    kind: z.enum(TASK_KINDS).optional(),
    slice: z.string().min(1).optional(),
    noSlice: z.boolean().optional(),
    policy: RequestedPolicyFields.optional(),
  })
  .refine((args) => args.pr !== undefined || args.branch !== undefined, { message: "needs a pr or a branch", path: ["pr"] })
  .refine((args) => args.slice === undefined || !args.noSlice, { message: "slice and noSlice are exclusive", path: ["noSlice"] });

export type RegisterArgs = z.infer<typeof RegisterArgs>;

/** A deny or unreadable seat book throws here, before anything is looked up or started. */
export function policyFor(seats: () => SeatBook, args: RegisterArgs): EffectivePolicy {
  try {
    return resolveEffectivePolicy(lookupSeat(seats(), args.repo), args.policy ?? {});
  } catch (error) {
    if (error instanceof RegistrationRefused) throw coded(`registration refused: ${error.message}`, EXIT.DATAERR);
    throw error;
  }
}

/**
 * A PR registration always learns its head branch, so a later branch registration finds it and vice versa. A caller that
 * passes the head with the branch registers from facts it read itself, so the branch is trusted and GitHub is not asked.
 */
export async function headBranch(port: GitHubPort, args: RegisterArgs): Promise<string | undefined> {
  if (args.pr === undefined || (args.branch !== undefined && args.head !== undefined)) return args.branch;
  const { headRef } = await port.getPr(args.repo, args.pr);
  if (args.branch !== undefined && args.branch !== headRef) throw coded(`${args.repo}#${args.pr} has head ${headRef}, not ${args.branch}`, EXIT.DATAERR);
  return headRef;
}

/** A repeat register without a slice keeps the stored one; only an explicit noSlice clears it. */
export function sliceAfter(existing: Registration, args: RegisterArgs): string | undefined {
  if (args.noSlice) return undefined;
  return args.slice ?? existing.slice ?? undefined;
}

/** Checked before a failed run is replaced, so a refused kind leaves the run and its registration untouched. */
export function refuseKindMove(existing: Registration, args: RegisterArgs, { guard, diff }: KindMove): void {
  const refusal = args.kind === undefined ? undefined : guard(existing.kind, args.kind, diff);
  if (refusal) throw coded(`registration refused: run ${existing.runId}: ${refusal}`, EXIT.DATAERR);
}
