import { DEFAULT_CLASS_RULES, type ClassRules } from "@titan-design/review-panel";

/** Shepherd's merge-policy files. These tables sit apart from registration-hold.ts so risk-tier.ts can read them without an import cycle through policy.ts. */
export const MERGE_POLICY_FILES = ["g10-*.ts", "adversary-*.ts", "merge-evidence-gate.ts", "task-kind.ts", "registration-hold.ts", "release-head.ts", "risk-tier.ts"].map((name) => `**/${name}`);
/** Shepherd's hold, release, seat and reviewer-choice code, matched by exact path because the names are common elsewhere. */
export const HOLD_COMMAND_FILES = ["commands.ts", "operator-hold.ts", "seats.ts", "release.ts", "reviewer-choice.ts"].map((name) => `products/factory/src/shepherd/${name}`);
/**
 * The owner's own levers: the console's tap and inbox actions, gate resolution and owner release (titan-coord's E1
 * amendment to 458). Globbed by name stem, so a helper split out of one of these files stays held.
 */
export const OWNER_ACTION_FILES = ["apps/console/server/**/owner-tap*.ts", "apps/console/server/**/inbox-actions*.ts", "products/factory/src/**/gate-resolve*.ts", "products/factory/src/**/*owner-release*.ts"];

/**
 * Who may resolve a gate (TP-4052, tp#2253): files that build a `GateResolver` or hand one to a resolve sink, and
 * checks they lean on. A diff here can widen gate resolves past the owner as surely as an authority table edit.
 * `gate-resolve-sites.test.ts` is a heuristic trigger: it fails when a file the type-checker closure finds is not
 * held. It does not prove the list complete. Forms it misses are filed as gap tasks TP-4063 to TP-4067.
 */
const GATE_RESOLVE_ACTOR_FILES = [
  // hitl is the gate store itself: the resolver refusal, allowances, payload schema and the stores that apply them.
  "packages/hitl/src/**",
  // The resolve sinks, the signal and resolver contract they take, and their gate authorize step.
  "packages/workflow/src/runtime.ts",
  "packages/workflow/src/types.ts",
  "packages/workflow/src/authorize.ts",
  // The Matrix answer path: the mirror that picks the owner the fold compares against, its sources, the owner-remote
  // resolver, and the fold that checks the sender is the owner.
  "packages/queue-mirror/src/**",
  "packages/matrix-bus/src/fold.ts",
  // The owner queue's source port, owner answers on rounds, and the answer shape that names who gave them.
  "packages/owner-queue/src/port.ts",
  "packages/owner-queue/src/round-items.ts",
  "packages/owner-queue/src/schema.ts",
  // The factory's owner-queue sources, whose `resolve` answers an item at its store of record.
  "products/factory/src/needs/*-source.ts",
  // The land workflow's gate rules: which resolver classes and delegates may answer each row.
  "products/factory/src/workflows/land-approval.ts",
  // The factory's answer entry points, each of which stamps a resolver class.
  "products/factory/src/gate-answer-*.ts",
  "products/factory/src/gate-batch*.ts",
  "products/factory/src/gate-notify*.ts",
  "products/factory/src/cli-host-verbs.ts",
  "products/factory/src/console-action/**",
  "products/factory/src/owner-ops/**",
  "products/factory/src/shepherd/round-ship-sweep.ts",
  // Owner presence and the signed proofs that turn into owner-class resolvers.
  "products/factory/src/owner-presence*.ts",
  "products/factory/src/owner-keys*.ts",
  "products/factory/src/presence-proof.ts",
  "products/factory/src/owner-proof-statement.ts",
  "products/factory/src/resolve-proof.ts",
  "products/factory/src/hold-release-proof.ts",
  // The store wiring and the evidence, allowance and authorize rules that widen the default refusal.
  "products/factory/src/host.ts",
  "products/factory/src/**/coordinator-evidence*.ts",
  "products/factory/src/**/coordinator-allowances*.ts",
  "products/factory/src/device-gates.ts",
  "products/factory/src/shepherd/stale-gates.ts",
];

/**
 * The owner's skill-diff guard (CC-1120): a head that changes a repo skill gates for the owner at that head, and no
 * earlier approval carries onto it. These files build no resolver, so the closure cannot find them; they are listed.
 */
const OWNER_SKILL_GUARD_FILES = ["merge-facts.ts", "skill-paths.ts", "approval-carry.ts"].map((name) => `products/factory/src/shepherd/${name}`);

/** agent-chat's leak guard, self-grant, permission hook and host directory (owner decision 350 Q5), and its agent profiles (458 E1); test files stay exempt in the panel. */
const AGENT_CHAT_SECURITY_FILES = ["src/leak-guard/**", "src/agents/*self-grant*", "src/cli/verbs/permission-hook.ts", "src/broker/host-directory.ts", "profiles/*.json", "src/agents/profile*.ts"];

/** Shepherd's merge policy and the owner's levers live in plain source files, which the panel's default globs miss. */
export const SHEPHERD_CLASS_RULES: ClassRules = {
  ...DEFAULT_CLASS_RULES,
  policy: [...DEFAULT_CLASS_RULES.policy, ...MERGE_POLICY_FILES, ...HOLD_COMMAND_FILES, ...OWNER_ACTION_FILES, ...GATE_RESOLVE_ACTOR_FILES, ...OWNER_SKILL_GUARD_FILES],
  security: [...DEFAULT_CLASS_RULES.security, ...AGENT_CHAT_SECURITY_FILES],
};
