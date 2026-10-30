import { parseResultLine, proofStanding } from "@titan-design/fix-proof";
import { DEFAULT_SHAPE_ROLES, DEFAULT_SONNET_FOR, type ClassRoles, type PanelPolicy, type ReviewTarget } from "@titan-design/review-panel";
import type { HoldMember, ReviewPlanPolicy } from "./plan-for-head.js";
import type { PreflightSnapshot } from "./preflight.js";
import type { ProofRead, ReviewWorkflowPorts } from "./ports.js";

export interface PreflightReadInput {
  target: ReviewTarget;
  policy: ReviewPlanPolicy;
  hold?: HoldMember;
}

export type PreflightPorts = Pick<ReviewWorkflowPorts, "snapshot" | "proofReader" | "carry" | "checkout" | "headroom" | "profiles">;

/** Every profile the policy can seat, including each premium profile's sonnet fallback, so the plan's members are all among them. */
function candidateProfiles(policy: PanelPolicy, hold: HoldMember | undefined): string[] {
  const shapeRoles = Object.values({ ...DEFAULT_SHAPE_ROLES, ...policy.shapeRoles }).filter((roles): roles is ClassRoles => roles !== undefined);
  const sonnetFor = policy.sonnetFor ?? DEFAULT_SONNET_FOR;
  const named = [policy.roles, ...shapeRoles].flatMap((roles) => Object.values(roles));
  return [...new Set([...named, ...Object.keys(sonnetFor), ...Object.values(sonnetFor), ...(hold === undefined ? [] : [hold.profile])])].sort();
}

/** The base a judged line names at this head; a workflow-ci read names none here. */
function judgedBase(read: ProofRead, head: string): string | undefined {
  if (read.kind !== "result" && read.kind !== "untrusted") return undefined;
  const parsed = parseResultLine(read.line);
  return parsed.ok && parsed.result.head === head ? parsed.result.base : undefined;
}

/** The `preflight-read` step body: one pass over the ports, so `preflight` decides on a recorded snapshot and never reads. */
export async function preflightRead({ target, policy, hold }: PreflightReadInput, ports: PreflightPorts): Promise<PreflightSnapshot> {
  const [head, read, carry, checkout, headroom] = await Promise.all([
    ports.snapshot.read(target),
    ports.proofReader.read(target),
    ports.carry.probe(target),
    ports.checkout.state(target),
    ports.headroom.read(),
  ]);
  const profiles = Object.fromEntries(candidateProfiles(policy.panel, hold).map((profile) => [profile, ports.profiles.installed(profile)]));
  const proofBase = judgedBase(read, target.head);
  const proof = proofStanding(read, target.head);
  return { target, head, proof, ...(proofBase !== undefined && { proofBase }), carry, checkout, headroom, profiles, ...(hold !== undefined && { hold: { profile: hold.profile } }) };
}
