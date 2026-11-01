import { isDeepStrictEqual } from "node:util";
import type { MergeMethod } from "@titan-design/github";
import { z } from "zod";
import type { PlanApproval } from "./plan-approval.js";

export const MERGE_ORDER = ["never", "owner-gate", "auto"] as const;

export type MergeMode = (typeof MERGE_ORDER)[number];

export const OWNER_GATE_REASONS = ["gate-2-visual", "g10-security", "proof-fixture", "owner-asked"] as const;

export type OwnerGateReason = (typeof OWNER_GATE_REASONS)[number];

/** A check that diffs rendered output against committed baselines: a rendered change must change a file under `paths`. */
export interface VisualBaselines {
  check: string;
  paths: string[];
}

export interface VisualPolicy {
  visualPaths: readonly string[] | undefined;
  visualBaselines: VisualBaselines | undefined;
}

export interface EffectivePolicy {
  merge: MergeMode;
  mergeMethod: MergeMethod;
  reviewer?: string;
  priority?: number;
  fixer: boolean;
  /** Why the owner is asked; absent on an owner-gate run registered before the field, which reads as legacy. */
  ownerGateReason?: OwnerGateReason;
  /** The seat that set the ceiling, or `none` for a repo no seat lists. */
  seat: string;
  /** Under `auto`, a head whose changed files match one of these globs still waits for the owner. */
  visualPaths?: string[];
  /** The seat's baseline check and files: a head matching `visualPaths` that changes no baseline merges on that check's success. */
  visualBaselines?: VisualBaselines;
  /** The seat's `merge-into-feature-base` grant: the merge may land in a base other than the default branch; absent, it waits for a retarget. */
  featureBase?: true;
  /** The seat's `release-merge` grant: a Version Packages PR may merge on its preflight; absent, the release waits for the owner. */
  release?: "grant";
  /**
   * The owner's plan approvals this run claimed, attached by each `sh-policy` read and never stored or taken from a run
   * param: `EffectivePolicySchema` refuses the key, so only the store's console-written rows reach the guard.
   */
  approved?: PlanApproval[];
}

/** An `EffectivePolicy` read back from a run param or the store; unknown keys, `approved` among them, are refused. */
export const EffectivePolicySchema: z.ZodType<EffectivePolicy> = z.strictObject({
  merge: z.enum(MERGE_ORDER),
  mergeMethod: z.enum(["merge", "squash", "rebase"] satisfies MergeMethod[]),
  reviewer: z.string().optional(),
  priority: z.number().int().optional(),
  fixer: z.boolean(),
  ownerGateReason: z.enum(OWNER_GATE_REASONS).optional(),
  seat: z.string(),
  visualPaths: z.array(z.string()).optional(),
  visualBaselines: z.strictObject({ check: z.string(), paths: z.array(z.string()) }).optional(),
  featureBase: z.literal(true).optional(),
  release: z.literal("grant").optional(),
});

export class RegistrationRefused extends Error {
  override readonly name = "RegistrationRefused";
}

export function narrower(a: MergeMode, b: MergeMode): MergeMode {
  return MERGE_ORDER.indexOf(a) <= MERGE_ORDER.indexOf(b) ? a : b;
}

/**
 * `trusted` narrowed by `other`: an inherited or untrusted policy can tighten the merge mode, add visual paths or drop a
 * feature base, release grant or visual baselines, never loosen any. Baselines clear visual heads, so they survive only
 * when both sides carry the same ones; a run stored before the field has none and keeps the glob gate. Plan approvals
 * clear guard rows, so they follow the same rule.
 */
export function stricterPolicy(trusted: EffectivePolicy, other: EffectivePolicy): EffectivePolicy {
  const merge = narrower(trusted.merge, other.merge);
  const visualPaths = trusted.visualPaths || other.visualPaths ? [...new Set([...(trusted.visualPaths ?? []), ...(other.visualPaths ?? [])])] : undefined;
  const ownerGateReason = trusted.ownerGateReason ?? other.ownerGateReason;
  const stricter: EffectivePolicy = { ...trusted, merge, ...(ownerGateReason && { ownerGateReason }), fixer: trusted.fixer && other.fixer, seat: merge === trusted.merge ? trusted.seat : other.seat, ...(visualPaths && { visualPaths }) };
  if (!other.featureBase) delete stricter.featureBase;
  if (other.release !== "grant") delete stricter.release;
  if (!isDeepStrictEqual(trusted.visualBaselines, other.visualBaselines)) delete stricter.visualBaselines;
  if (!isDeepStrictEqual(trusted.approved, other.approved)) delete stricter.approved;
  return stricter;
}

/** A repeat registration narrows the stored policy, but the first owner-gate reason stands: a repeat cannot relabel why the owner is asked. */
export function repeatedPolicy(repeat: EffectivePolicy, stored: EffectivePolicy): EffectivePolicy {
  const narrowed = stricterPolicy(repeat, stored);
  const ownerGateReason = stored.ownerGateReason ?? narrowed.ownerGateReason;
  return { ...narrowed, ...(ownerGateReason && { ownerGateReason }) };
}
