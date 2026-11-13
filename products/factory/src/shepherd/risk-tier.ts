import { compileGlobs } from "@titan-design/fix-proof";
import { DEFAULT_CLASS_RULES } from "@titan-design/review-panel";
import type { CiPolicy } from "@titan-design/session-read";
import { HOLD_COMMAND_FILES, MERGE_POLICY_FILES, OWNER_ACTION_FILES, policyTablesOf, shepherdPathTouches, type PolicyTable } from "./g10-class-rules.js";
import { OWNER_PACKET_FILES, adversaryTouches } from "./signoffs.js";
import { skillPathsIn } from "./skill-paths.js";
import type { Registration } from "./store.js";
import { shownPaths, visualMatches } from "./visual-gate.js";
import type { VisualGateMode } from "./visual-gate-config.js";
import { keepsOwnerGate, visualGateMode } from "./visual-gate-mode.js";

/**
 * TP-3734 tiers: low merges on green CI and a MERGE, medium needs one more agent sign-off, high needs the owner.
 * The tier is recorded on the merge evidence; the owner-tier rows below (TP-5406) are what the merge guard decides on.
 */
export type RiskTierName = "low" | "medium" | "high";

export interface RiskTier {
  tier: RiskTierName;
  /** Every fact that raised the tier above low, each led by the tier it asks for. */
  reasons: string[];
}

/** The adversary's word on what an agent may now do (r7); absent until the reviewer brief asks for it. */
export type AuthorityLine = "unchanged" | "tightened" | "widened";

interface RiskFacts {
  /** Every changed path, a rename's old path included. */
  paths: readonly string[];
  /** The touches the paths make under Shepherd's class rules, test files exempt. */
  touches: readonly string[];
  ownerPacket: readonly string[];
  skillPaths: readonly string[];
  ciPolicy?: CiPolicy;
  authorityLine?: AuthorityLine;
  /** The changed files the run's visual policy names. */
  visual: readonly string[];
  /** Why the owner holds or gates the run itself, or undefined when nothing of the owner's does. */
  ownerHold: string | undefined;
  /** Non-generated additions plus deletions; undefined when a file carried no counts. */
  changedLines: number | undefined;
  /** Why the changed files could not be read whole. */
  unread: string | undefined;
  /** Set by the revert breaker (TP-3736): low becomes medium. */
  tighten?: boolean;
  /** `shepherd.visualGate` (TP-5408): under `async` a visual path alone raises no tier; absent means `owner`. */
  visualGate?: VisualGateMode;
}

/** Owner Q4 (decision 504): past this many lines a second correctness MERGE is the medium sign-off; below it size picks the reviewer only. */
const DEEP_REVIEW_LINES = 800;

/** Owner Q2 (decision 504): CI workflow files need a person even when the reviewer writes `CI-policy: unchanged`. */
const CI_PERSON_FILES = [".github/workflows/**", ".github/codeowners", ".codewatch/**"];

/** TP-5403 Q1: the files that cut or publish a release, so a policy touch among them stays the owner's. */
const PUBLISH_FILES = [
  ".changeset/config.json",
  ...["version-packages.ts", "release-follow.ts", "bump-*.ts", "consumer-bump*.ts", "leftover-bump.ts"].map((name) => `products/factory/src/shepherd/${name}`),
  "products/factory/src/cli-release.ts",
];

/** TP-5403 Q1: agent settings and the factory config, which sets defaults such as the gate-reset switches. */
const SETTINGS_FILES = [".claude/**", ".agent-chat/**", "products/factory/src/config.ts", "products/factory/src/config-ref.ts"];

/** Owner Q1 (decision 504): the files that define the owner's own gates, so an agent sign-off never stands in for theirs. */
const OWNER_LEVER_FILES = [...MERGE_POLICY_FILES, ...HOLD_COMMAND_FILES, ...OWNER_ACTION_FILES].map((glob) => glob.toLowerCase());

/** Case and trailing dots or spaces fold away per segment, as some filesystems ignore them, so `.GitHub./Workflows` still matches. */
const folded = (path: string): string =>
  path
    .split("/")
    .map((segment) => segment.toLowerCase().replace(/[ .]+$/, ""))
    .join("/");

function matching(paths: readonly string[], globs: readonly string[]): string[] {
  const matches = compileGlobs(globs);
  return paths.filter((path) => matches(folded(path)));
}

const isTest = compileGlobs(DEFAULT_CLASS_RULES.test);

function ciPolicyReason(ciPolicy: CiPolicy | undefined): string | undefined {
  if (ciPolicy?.kind === "weakened") return `CI policy weakened (${ciPolicy.keys.join(", ")})`;
  return ciPolicy?.kind === "malformed" ? "CI-policy line malformed" : undefined;
}

const pathReason = (what: string, paths: readonly string[]): string | undefined => (paths.length > 0 ? `${what} ${shownPaths(paths)}` : undefined);

/** The gate model's owner stop list (TP-5406): a path in one of these named policy tables waits for the owner at merge. */
const OWNER_TIER_TABLES: readonly PolicyTable[] = ["merge-policy", "hold-command", "owner-action", "gate-resolve-actor", "gate-resolve-check"];

const GATE_RESOLVE_TABLES: readonly PolicyTable[] = ["gate-resolve-actor", "gate-resolve-check"];

/** Each changed path the policy class holds, its case-folded spelling included, with the named tables that hold it. */
const policyTablesAt = (paths: readonly string[]): Map<string, PolicyTable[]> => policyTablesOf([...new Set([...paths, ...paths.map(folded)])].map((path) => ({ path })));

const heldIn = (tablesOf: ReadonlyMap<string, readonly PolicyTable[]>, wanted: readonly PolicyTable[]): string[] =>
  [...tablesOf].filter(([, tables]) => tables.some((table) => wanted.includes(table))).map(([path]) => path);

/** A held path no named table covers: an unknown class keeps the owner gate. */
const unnamedIn = (tablesOf: ReadonlyMap<string, readonly PolicyTable[]>): string[] => [...tablesOf].filter(([, tables]) => tables.length === 0).map(([path]) => path);

/** One row per table, its paths shown as the tier's reasons show them, so the row count stays bounded on a wide diff. */
const tableRow = (label: string, paths: readonly string[]): string[] => (paths.length > 0 ? [`${label} ${shownPaths(paths)}`] : []);

/** The policy-table owner-tier rows of a `policyTablesOf` read, each led by its table name. */
export function ownerTierPolicyRows(tablesOf: ReadonlyMap<string, readonly PolicyTable[]>): string[] {
  const named = OWNER_TIER_TABLES.flatMap((table) => tableRow(table, heldIn(tablesOf, [table])));
  return [...named, ...tableRow("unnamed policy path", unnamedIn(tablesOf))];
}

/** What the owner-tier rows read at a head: its changed paths, and whether a CI change is a budget one a coordinator may accept. */
interface OwnerTierRead {
  paths: readonly string[];
  /** Owner decision 552 (2), Q-S2a: a measured budget-class CI change keeps its coordinator path, so the CI row skips it. */
  ciBudget: boolean;
}

/**
 * The high-tier rows that stop for the owner at merge, each led by its table name. Visual, skill, unread files, the owner
 * packet, CI policy and owner holds are left out: visual by the task, the rest because each gates on its own row already.
 */
export function ownerTierRows({ paths, ciBudget }: OwnerTierRead): string[] {
  const named = (label: string, globs: readonly string[]): string[] => tableRow(label, matching(paths, globs));
  const ci = ciBudget ? [] : named("CI workflow file", CI_PERSON_FILES);
  return [...ownerTierPolicyRows(policyTablesAt(paths)), ...ci, ...named("publish file", PUBLISH_FILES), ...named("settings file", SETTINGS_FILES)];
}

/** A failed read never lowers a tier: unread or empty file lists read as high, as the merge guard reads them visual. */
function highReasons(facts: RiskFacts): (string | undefined)[] {
  const unread = facts.unread ?? (facts.paths.length === 0 ? "no changed files were read" : undefined);
  return [
    unread && `changed files unread: ${unread}`,
    pathReason("skill path", facts.skillPaths),
    pathReason("owner packet", facts.ownerPacket),
    pathReason("owner gate file", matching(facts.paths.filter((path) => !isTest(path)), OWNER_LEVER_FILES)),
    pathReason("gate-resolve file", heldIn(policyTablesAt(facts.paths), GATE_RESOLVE_TABLES)),
    pathReason("CI workflow file", matching(facts.paths, CI_PERSON_FILES)),
    pathReason("publish file", matching(facts.paths, PUBLISH_FILES)),
    pathReason("settings file", matching(facts.paths, SETTINGS_FILES)),
    ciPolicyReason(facts.ciPolicy),
    facts.authorityLine === "widened" ? "Authority widened" : undefined,
    visualGateMode(facts.visualGate) === "async" ? undefined : pathReason("visual", facts.visual),
    facts.ownerHold && `owner hold: ${facts.ownerHold}`,
  ];
}

/** Size buys a deeper review, never the owner (invariant 1). */
function mediumReasons(facts: RiskFacts): (string | undefined)[] {
  const adversary = adversaryTouches(facts.touches);
  const lines = facts.changedLines;
  return [
    adversary.length > 0 ? `${adversary.join(", ")} touch` : undefined,
    pathReason(".github path", matching(facts.paths, [".github/**"])),
    lines !== undefined && lines > DEEP_REVIEW_LINES ? `size: ${lines} changed lines, over ${DEEP_REVIEW_LINES}` : undefined,
  ];
}

const present = (reasons: (string | undefined)[]): string[] => reasons.filter((reason): reason is string => reason !== undefined && reason !== "");

/** The highest tier any fact at the head asks for (invariant 3); pure, so a head move re-computes it from that head's facts. */
export function riskTier(facts: RiskFacts): RiskTier {
  const high = present(highReasons(facts)).map((reason) => `high: ${reason}`);
  const medium = present(mediumReasons(facts)).map((reason) => `medium: ${reason}`);
  const reasons = [...high, ...medium];
  if (high.length > 0) return { tier: "high", reasons };
  if (medium.length > 0) return { tier: "medium", reasons };
  return facts.tighten ? { tier: "medium", reasons: ["medium: tightened after reverts"] } : { tier: "low", reasons: [] };
}

/** What the merge-evidence step reads at a head, before the class rules and the run's visual globs are applied. */
interface RiskRead {
  paths: readonly string[];
  changedLines: number | undefined;
  unread: string | undefined;
  ciPolicy?: CiPolicy;
  visualPaths?: readonly string[];
  ownerHold: string | undefined;
  visualGate?: VisualGateMode;
}

export function riskFactsOf({ paths, changedLines, unread, ciPolicy, visualPaths, ownerHold, visualGate }: RiskRead): RiskFacts {
  const ownerPacket = paths.filter((path) => OWNER_PACKET_FILES.includes(folded(path)));
  const touches = shepherdPathTouches(paths.map((path) => ({ path })));
  const visual = visualPaths === undefined ? [] : visualMatches(paths, visualPaths);
  return { paths, touches, ownerPacket, skillPaths: skillPathsIn(paths), ...(ciPolicy && { ciPolicy }), visual, ownerHold, changedLines, unread, ...(visualGate && { visualGate }) };
}

const OWNER_GATE_RISK: readonly string[] = ["owner-asked", "gate-2-visual"];
const OWNER_HOLD_CLASSES: readonly string[] = ["owner-asked", "visual-gate2"];

/**
 * The owner's own hold or registration gate on the run: an owner-asked slot, a visual-gate2 hold, or an owner-asked or
 * visual registration. Under `visualGate: async` the visual hold and registration are not the owner's (TP-5408).
 */
export function ownerHoldOf(registration: Registration | undefined, visualGate?: VisualGateMode): string | undefined {
  if (registration === undefined) return undefined;
  if (registration.ownerHold) return registration.ownerHold.reason;
  const held = registration.held ? registration.holdReason : null;
  const heldClass = held?.split(":")[0] ?? "";
  if (held !== null && OWNER_HOLD_CLASSES.includes(heldClass) && keepsOwnerGate(visualGate, heldClass)) return held;
  const gate = registration.policy.ownerGateReason;
  return gate !== undefined && OWNER_GATE_RISK.includes(gate) && keepsOwnerGate(visualGate, gate) ? `owner gate ${gate}` : undefined;
}
