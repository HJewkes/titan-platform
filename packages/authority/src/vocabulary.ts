export const ACTOR_CLASSES = ["owner-terminal", "owner-remote", "coordinator", "worker", "headless", "automation"] as const;

/** The only classes that may resolve a gate: the owner, at a terminal or through a verified remote channel. */
export const RESOLVER_CLASSES = ["owner-terminal", "owner-remote"] as const;

/** The only classes a gate's rule may name as a delegate resolver; anything a delegate answers still goes through `authorize`. */
export const DELEGATE_RESOLVER_CLASSES = ["coordinator"] as const;

export const ACTION_CLASSES = [
  "merge",
  "release",
  "secret-read",
  "untrusted-ingest",
  "private-to-public",
  "private-egress",
  "hardware-actuate",
  "hardware-stop",
  "destructive-remote",
  "destructive-local",
  "destructive-foreign",
  "spawn",
  "spend-over-cap",
  "authority-config",
  "human-verb",
] as const;

export const VERDICTS = ["allow", "gate", "deny"] as const;

/** Codes for the record each rule expects to leave behind, from a decision record to a device read-back. */
export const EVIDENCE_KINDS = ["E-dec", "E-gate", "E-ref", "E-byp", "E-gh", "E-npm", "E-spn", "E-prin", "E-dev", "E-rev"] as const;

/** Facts a conditional rule checks on the request; the rule applies only when every one holds. */
export const CONDITION_KINDS = [
  "resolver-is-dispatched-reviewer",
  "verdict-merge-at-head",
  "verdict-merge-carried-tree-equal",
  "verdict-merge-carried-remerge-clean",
  "pr-kind-not-security",
  "required-contexts-green",
  "no-non-green-run",
  "merge-tree-clean",
  "repo-not-frozen",
  "no-protected-path-change",
  "seat-grants-merge-on-green-approve",
] as const;

export type ActorClass = (typeof ACTOR_CLASSES)[number];
export type ResolverClass = (typeof RESOLVER_CLASSES)[number];
export type DelegateResolverClass = (typeof DELEGATE_RESOLVER_CLASSES)[number];
export type ActionClass = (typeof ACTION_CLASSES)[number];
export type Verdict = (typeof VERDICTS)[number];
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];
export type ConditionKind = (typeof CONDITION_KINDS)[number];
