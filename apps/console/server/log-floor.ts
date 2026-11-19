/**
 * The exclusion floor as the #/log header shows it (TP-6775). The floor itself is code in owner-queue's `BY_REC_FLOOR`;
 * this table only words each class for the owner. A floor class has no remove control: the only way out is the owner-only
 * change named in `removeBy`. Exclusions the policy file adds are listed apart, since the file can only add.
 */
import { BY_REC_FLOOR, type ByRecExclusion, type ByRecPolicy } from "@titan-design/owner-queue";

export interface FloorClass {
  reason: string;
  label: string;
  removeBy: string;
}

export interface LogHeader {
  mode: ByRecPolicy["mode"];
  afterHours: number;
  minConfidence?: number;
  /** Set when the policy file is present but unusable, so the sweeps run with mode off. */
  problem?: string;
  floor: FloorClass[];
  added: ByRecExclusion[];
  /** The owner has not confirmed the floor; the page says so above it. */
  unconfirmed: true;
}

const FLOOR_PR = "an owner-approved PR that removes it from BY_REC_FLOOR in packages/owner-queue, gated like an authority change";
const MERGE_PR = `${FLOOR_PR}, plus the matching MRG-AU-RB condition for merges`;
const NEVER = "not removable: without it there is nothing to resolve";

const LABELS: Record<string, readonly [label: string, removeBy: string]> = {
  closed: ["Already answered, decided, expired or withdrawn", NEVER],
  "no-recommendation": ["No recommendation attached", NEVER],
  "g10-hold": ["Any g10 hold (g10-review, g10-adversary, matched by prefix)", MERGE_PR],
  "security-class": ["Security decisions (D1: g10-security, proof-fixture)", MERGE_PR],
  "guard-class": ["Guard decisions (D21: skill paths, CI policy weakened, over budget or malformed)", MERGE_PR],
  "owner-at-head": ["Owner-at-head rows (skill-path, files-unread, attest-unmet)", MERGE_PR],
  "guard-path": ["Authority and guard paths (authority table, g10 rules, hold and policy files, this policy)", MERGE_PR],
  release: ["Release PRs and release deposits (REL-*)", MERGE_PR],
  publish: ["Publish and external (PUB-*, EXT-*)", MERGE_PR],
  secret: ["Secret reads (SEC-*)", FLOOR_PR],
  hardware: ["Hardware actuation (HW-*)", FLOOR_PR],
  money: ["Spend, money or accounts, or any $ amount", FLOOR_PR],
  "one-way": ["One-way doors", FLOOR_PR],
  irreversible: ["Items marked irreversible", FLOOR_PR],
  "on-silence-wait": ["The asker said wait on silence", FLOOR_PR],
  "on-silence-expire": ["The asker said expire on silence", FLOOR_PR],
  blind: ["Blind picks (recommendation shown after the answer)", FLOOR_PR],
  "change-requested": ["Change requested", FLOOR_PR],
  personal: ["Personal items", FLOOR_PR],
  "not-a-decision": ["Do-steps and sitting deposits", NEVER],
  "operator-audience": ["Operator-audience items", FLOOR_PR],
  "owner-op": ["Deposits carrying an owner op (merge-at-head, close-pr)", FLOOR_PR],
  ship: ["Ship questions in rounds (their PR goes through its own merge gate)", NEVER],
  "plan-approval": ["Plan approvals in rounds", FLOOR_PR],
  "answer-unsound": ["A recommendation that is not an offered option, or that the asker's default contradicts", NEVER],
};

/** A floor class this table does not word still shows, by its code name, so a new class is never hidden. */
export function floorClasses(): FloorClass[] {
  return BY_REC_FLOOR.map(([reason]) => {
    const [label, removeBy] = LABELS[reason] ?? [reason, FLOOR_PR];
    return { reason, label, removeBy };
  });
}

export function logHeader(policy: ByRecPolicy, problem: string | undefined): LogHeader {
  return {
    mode: policy.mode,
    afterHours: policy.afterHours,
    ...(policy.minConfidence !== undefined && { minConfidence: policy.minConfidence }),
    ...(problem !== undefined && { problem }),
    floor: floorClasses(),
    added: policy.exclude,
    unconfirmed: true,
  };
}
