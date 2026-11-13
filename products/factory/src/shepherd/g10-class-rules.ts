import { compileGlobs } from "@titan-design/fix-proof";
import { DEFAULT_CLASS_RULES, pathTouches, type ChangedFile, type ClassRules } from "@titan-design/review-panel";
import { z } from "zod";
import holdClosureJson from "./g10-hold-closure.json" with { type: "json" };

const inShepherd = (name: string): string => `products/factory/src/shepherd/${name}`;

/** Shepherd's merge-policy files. These tables sit apart from registration-hold.ts so risk-tier.ts can read them without an import cycle through policy.ts. */
export const MERGE_POLICY_FILES = ["g10-*.ts", "adversary-*.ts", "merge-evidence-gate.ts", "task-kind.ts", "registration-hold.ts", "release-head.ts", "risk-tier.ts", "owner-tier.ts", "merge-facts.ts"].map((name) => `**/${name}`);
/** Shepherd's hold, release, seat and reviewer-choice code, matched by exact path because the names are common elsewhere. */
export const HOLD_COMMAND_FILES = ["commands.ts", "operator-hold.ts", "seats.ts", "release.ts", "reviewer-choice.ts"].map((name) => `products/factory/src/shepherd/${name}`);
/**
 * The owner's own levers: the console's tap and inbox actions, gate resolution and owner release (titan-coord's E1
 * amendment to 458), plus the fix-proof gate's config, whose edit can weaken a merge gate. Globbed by name stem, so a helper split out of one of these files stays held.
 */
export const OWNER_ACTION_FILES = ["apps/console/server/**/owner-tap*.ts", "apps/console/server/**/inbox-actions*.ts", "products/factory/src/**/gate-resolve*.ts", "products/factory/src/**/*owner-release*.ts", ".github/fix-proof.json"];

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

/**
 * The closure check for who may resolve a gate as one unit (TP-4065): the test, its mutation sidecar and the helpers that
 * compute the closure. Weakening any of them lets a new resolver site go unheld, so the unit is policy, test file or not.
 */
export const GATE_RESOLVE_CHECK_FILES = ["gate-resolve-sites.test.ts", "gate-resolve-sites.test.mutations.json", "gate-resolve-*.test-helpers.ts"].map(
  (name) => `products/factory/src/shepherd/${name}`,
);

/**
 * Code that decides sign-offs, fix-proof verdicts, proof waivers and merge standing, or writes the hold rows they read
 * (TP-3764, TP-4746), and the modules that import the hold, the sign-off rule or the release. Emptying any of these
 * lifts a G10 hold as surely as editing this table. These seed the closure.
 */
const SIGNOFF_POLICY_FILES = [
  ...["signoffs.ts", "merge-standing.ts", "reviewer-lineage.ts", "auto-pass.ts", "fix-proof.ts", "take-verdict.ts", "store.ts", "events.ts"].map(inShepherd),
  ...["registration-of.ts", "proof-waiver.ts", "proof-waiver-table.ts", "seat-recheck.ts", "carry-merge.ts", "merge-up-carry.ts", "approved-set-carry.ts", "no-reviewer-hold.ts"].map(inShepherd),
  ...["await-pr.ts", "coverage.ts", "pr.ts", "shepherd-steps.ts"].map(inShepherd),
  // The production ShepherdPhases read the owner's visualSetCarry flag; the recipe lint keeps that adapter out of pr.ts.
  "products/factory/src/shepherd-phases.ts",
  "packages/fix-proof/src/**",
  "packages/review-panel/src/**",
];

/**
 * The hold table's completeness checks as one unit: the hold-closure test, its sidecar, its walk and the list it keeps,
 * the importer check (TP-3764) with its sidecar, and the same four for the low-tier refusal closure (TP-5403). Test file
 * or not, each is policy: deleting one lets an unheld module, or a low-tier one, through in the same pull request.
 */
const HOLD_CLOSURE_CHECK_FILES = [
  ...["g10-hold-closure.test.ts", "g10-hold-closure.test.mutations.json", "g10-hold-closure.test-helpers.ts", "g10-hold-closure.json"],
  ...["hold-table-coverage.test.ts", "hold-table-coverage.test.mutations.json"],
  ...["g10-low-tier-closure.test.ts", "g10-low-tier-closure.test.mutations.json", "g10-low-tier-closure.test-helpers.ts", "g10-low-tier-closure.json"],
].map(inShepherd);

const matchesHeldCheck = compileGlobs([...GATE_RESOLVE_CHECK_FILES, ...HOLD_CLOSURE_CHECK_FILES]);
/** Case-folded (TP-4158): a case-insensitive checkout still imports `Gate-Resolve-x.test-helpers.ts` as the helper. */
const inHeldCheck = (path: string): boolean => matchesHeldCheck(path.toLowerCase());

/** The named tables the listed policy class is the union of, in the order their globs are listed. */
const LISTED_POLICY_TABLES = {
  "default-policy": DEFAULT_CLASS_RULES.policy,
  "merge-policy": MERGE_POLICY_FILES,
  "hold-command": HOLD_COMMAND_FILES,
  "owner-action": OWNER_ACTION_FILES,
  "gate-resolve-actor": GATE_RESOLVE_ACTOR_FILES,
  "owner-skill-guard": OWNER_SKILL_GUARD_FILES,
  "gate-resolve-check": GATE_RESOLVE_CHECK_FILES,
  "signoff-policy": SIGNOFF_POLICY_FILES,
  "hold-closure-check": HOLD_CLOSURE_CHECK_FILES,
} satisfies Record<string, readonly string[]>;

/** The listed table, before the import closure: the seeds `g10-hold-closure.test.ts` walks from. */
export const SHEPHERD_LISTED_RULES: ClassRules = {
  ...DEFAULT_CLASS_RULES,
  policy: Object.values(LISTED_POLICY_TABLES).flat(),
  security: [...DEFAULT_CLASS_RULES.security, ...AGENT_CHAT_SECURITY_FILES],
};

/**
 * Every factory module a listed one imports, value or type-only, to a fixpoint, less those already listed, as paths
 * under `products/factory/src` (TP-4813: the walk crosses the whole tree, not just Shepherd's directory). A held module
 * reads its imports, so editing one can change what the hold decides. `g10-hold-closure.test.ts` recomputes the
 * closure and fails until this list matches it (`vitest -u` rewrites it).
 */
const HOLD_CLOSURE = z.array(z.string()).parse(holdClosureJson);

/** The tree the hold-closure walk covers, and the root its listed paths are relative to: all factory source, not just Shepherd's directory (TP-4813). */
export const HOLD_CLOSURE_ROOT = "products/factory/src";

const inClosureRoot = (name: string): string => `${HOLD_CLOSURE_ROOT}/${name}`;

/** The listed table with a closure of module paths, relative to `HOLD_CLOSURE_ROOT`, held as policy too. */
export const withHoldClosure = (names: readonly string[]): ClassRules => ({ ...SHEPHERD_LISTED_RULES, policy: [...SHEPHERD_LISTED_RULES.policy, ...names.map(inClosureRoot)] });

/** Shepherd's merge policy and the owner's levers live in plain source files, which the panel's default globs miss. */
export const SHEPHERD_CLASS_RULES: ClassRules = withHoldClosure(HOLD_CLOSURE);

/**
 * The panel's path touches under Shepherd's rules, a rename's old path included, with the gate-resolve and hold-closure
 * checks counted as policy despite the panel's test exemption.
 */
export function shepherdPathTouches(files: readonly Pick<ChangedFile, "path" | "previousPath">[]): string[] {
  const touches: string[] = pathTouches(files, SHEPHERD_CLASS_RULES);
  const inCheck = files.some(({ path, previousPath }) => inHeldCheck(path) || (previousPath !== undefined && inHeldCheck(previousPath)));
  return inCheck && !touches.includes("policy") ? [...touches, "policy"] : touches;
}

/** Every named table the policy class is the union of, the import closure last (TP-5403). */
export const POLICY_TABLES = { ...LISTED_POLICY_TABLES, "hold-closure": HOLD_CLOSURE.map(inClosureRoot) } satisfies Record<string, readonly string[]>;

export type PolicyTable = keyof typeof POLICY_TABLES;

const isPolicyTable = (name: string): name is PolicyTable => Object.hasOwn(POLICY_TABLES, name);
const POLICY_TABLE_NAMES: readonly PolicyTable[] = Object.keys(POLICY_TABLES).filter(isPolicyTable);

const HELD_CHECK_TABLES: ReadonlySet<PolicyTable> = new Set<PolicyTable>(["gate-resolve-check", "hold-closure-check"]);

function inTable(table: PolicyTable, path: string): boolean {
  if (pathTouches([{ path }], { ...SHEPHERD_CLASS_RULES, policy: POLICY_TABLES[table] }).includes("policy")) return true;
  return HELD_CHECK_TABLES.has(table) && compileGlobs(POLICY_TABLES[table])(path.toLowerCase());
}

/**
 * Each changed path the policy class holds, a rename's old path included, with the named tables it matches under the
 * same test exemption and held-check rule as `shepherdPathTouches`. A held path no table names maps to an empty list.
 */
export function policyTablesOf(files: readonly Pick<ChangedFile, "path" | "previousPath">[]): Map<string, PolicyTable[]> {
  const paths = files.flatMap(({ path, previousPath }) => (previousPath === undefined ? [path] : [path, previousPath]));
  const tables = new Map<string, PolicyTable[]>();
  for (const path of paths.filter((path) => shepherdPathTouches([{ path }]).includes("policy"))) {
    tables.set(path, POLICY_TABLE_NAMES.filter((table) => inTable(table, path)));
  }
  return tables;
}
