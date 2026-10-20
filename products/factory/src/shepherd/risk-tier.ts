import { compileGlobs } from "@titan-design/fix-proof";
import { DEFAULT_CLASS_RULES, pathTouches } from "@titan-design/review-panel";
import type { CiPolicy } from "@titan-design/session-read";
import { HOLD_COMMAND_FILES, MERGE_POLICY_FILES, OWNER_ACTION_FILES, SHEPHERD_CLASS_RULES } from "./g10-class-rules.js";
import { OWNER_PACKET_FILES, adversaryTouches } from "./signoffs.js";
import { skillPathsIn } from "./skill-paths.js";
import type { Registration } from "./store.js";
import { shownPaths, visualMatches } from "./visual-gate.js";

/**
 * TP-3734 tiers: low merges on green CI and a MERGE, medium needs one more agent sign-off, high needs the owner.
 * r1 only records the tier on the merge evidence; nothing decides on it yet.
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
}

/** Owner Q4 (decision 504): past this many lines a second correctness MERGE is the medium sign-off; below it size picks the reviewer only. */
const DEEP_REVIEW_LINES = 800;

/** Owner Q2 (decision 504): CI workflow files need a person even when the reviewer writes `CI-policy: unchanged`. */
const CI_PERSON_FILES = [".github/workflows/**", ".github/codeowners", ".codewatch/**"];

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

/** A failed read never lowers a tier: unread or empty file lists read as high, as the merge guard reads them visual. */
function highReasons(facts: RiskFacts): (string | undefined)[] {
  const unread = facts.unread ?? (facts.paths.length === 0 ? "no changed files were read" : undefined);
  return [
    unread && `changed files unread: ${unread}`,
    pathReason("skill path", facts.skillPaths),
    pathReason("owner packet", facts.ownerPacket),
    pathReason("owner gate file", matching(facts.paths.filter((path) => !isTest(path)), OWNER_LEVER_FILES)),
    pathReason("CI workflow file", matching(facts.paths, CI_PERSON_FILES)),
    ciPolicyReason(facts.ciPolicy),
    facts.authorityLine === "widened" ? "Authority widened" : undefined,
    pathReason("visual", facts.visual),
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
}

export function riskFactsOf({ paths, changedLines, unread, ciPolicy, visualPaths, ownerHold }: RiskRead): RiskFacts {
  const ownerPacket = paths.filter((path) => OWNER_PACKET_FILES.includes(folded(path)));
  const touches = pathTouches(paths.map((path) => ({ path })), SHEPHERD_CLASS_RULES);
  const visual = visualPaths === undefined ? [] : visualMatches(paths, visualPaths);
  return { paths, touches, ownerPacket, skillPaths: skillPathsIn(paths), ...(ciPolicy && { ciPolicy }), visual, ownerHold, changedLines, unread };
}

const OWNER_GATE_RISK: readonly string[] = ["owner-asked", "gate-2-visual"];
const OWNER_HOLD_CLASSES: readonly string[] = ["owner-asked", "visual-gate2"];

/** The owner's own hold or registration gate on the run: an owner-asked slot, a visual-gate2 hold, or an owner-asked or visual registration. */
export function ownerHoldOf(registration: Registration | undefined): string | undefined {
  if (registration === undefined) return undefined;
  if (registration.ownerHold) return registration.ownerHold.reason;
  const held = registration.held ? registration.holdReason : null;
  if (held !== null && OWNER_HOLD_CLASSES.includes(held.split(":")[0]!)) return held;
  const gate = registration.policy.ownerGateReason;
  return gate !== undefined && OWNER_GATE_RISK.includes(gate) ? `owner gate ${gate}` : undefined;
}
