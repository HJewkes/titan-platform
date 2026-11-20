import type { ByRecSource } from "./by-rec-schema.js";
import type { Audience, OnSilence } from "./schema.js";

export interface ByRecRecommendation {
  answer: string;
  by: string;
  rationale?: string;
  confidence?: number;
}

/**
 * A gate, round question or deposit, normalized so one policy decides all three. The sweep that builds it reads every
 * fact fresh; any field it cannot read it leaves out, and only fields that refuse on presence are optional.
 */
export interface ByRecSubject {
  source: ByRecSource;
  id: string;
  openedAt: string;
  summary?: string;
  recommendation?: ByRecRecommendation;
  /** OwnerItem kind, or `sitting` for a sitting deposit. */
  kind?: string;
  door?: "one-way" | "two-way";
  irreversible?: boolean;
  onSilence?: OnSilence;
  default?: string;
  options?: readonly string[];
  holdClasses?: readonly string[];
  /** The decision-routing D-row. */
  decisionClass?: string;
  authorityRows?: readonly string[];
  /** The table the authority rows come from; any table but `authority` refuses. */
  authorityTable?: string;
  ownerAtHead?: readonly string[];
  paths?: readonly string[];
  /** Set by a sweep whose own guard-path table matched a changed path. */
  guardPath?: boolean;
  headRef?: string;
  category?: string;
  op?: string;
  audience?: Audience;
  personal?: boolean;
  changeRequested?: boolean;
  /** A round with `recommendations: after-answer`, or a hidden pick. */
  blind?: boolean;
  ship?: boolean;
  planApproval?: boolean;
  /** Already answered, decided, expired, withdrawn or gone elsewhere. */
  closed?: boolean;
  /** Prompt, context and option text, scanned for a dollar amount. */
  text?: readonly string[];
}

type FloorRule = readonly [reason: string, refuses: (subject: ByRecSubject) => boolean];

const GUARD_CLASSES = new Set(["D21"]);
const SECURITY_CLASSES = new Set(["D1"]);
const OWNER_AT_HEAD_ROWS = new Set(["skill-path", "files-unread", "attest-unmet", "ci-policy-weakened", "ci-policy-budget", "ci-policy-malformed"]);
const RELEASE_REFS = new Set(["changeset-release/main"]);
const REF_PREFIX = /^refs\/heads\//;
const RELEASE_CATEGORIES = new Set(["release", "publish"]);
const MONEY_CATEGORIES = new Set(["spend", "money", "account"]);
const NOT_DECISIONS = new Set(["do", "sitting"]);
const DOLLAR_AMOUNT = /\$\s?\d/;
const AUTHORITY_PACKAGE = "packages/authority/";
const CI_AND_SETTINGS = /(^|\/)(\.github\/workflows\/|\.github\/merge-lint\.json$|codeowners$|\.claude\/settings[^/]*\.json$)/;
/**
 * Authority-table families whose rows may auto-resolve; every other family, including one added to the table later,
 * refuses, and so does a row from any table but `authority`. Spawn, retire, untrusted ingest and question answers carry
 * no owner-only verb.
 */
const AUTO_RESOLVABLE_FAMILIES = new Set(["SPN", "RET", "UNT", "ANS"]);
const AUTHORITY_TABLE = "authority";

const hasPrefix = (values: readonly string[] | undefined, prefixes: readonly string[]): boolean =>
  (values ?? []).some((value) => prefixes.some((prefix) => value.toLowerCase().startsWith(prefix.toLowerCase())));
const lower = (value: string | undefined): string => (value ?? "").trim().toLowerCase();
const familyOf = (row: string): string => row.trim().split("-")[0]?.toUpperCase() ?? "";
const hasFamily = (rows: readonly string[] | undefined, families: readonly string[]): boolean =>
  (rows ?? []).some((row) => families.includes(familyOf(row)));
const releaseRef = (ref: string | undefined): boolean => RELEASE_REFS.has((ref ?? "").trim().replace(REF_PREFIX, ""));

/**
 * Authority and guard files: the authority package, g10 rules, hold and policy files, CI workflows, merge-lint,
 * CODEOWNERS, settings, and this policy itself.
 */
export function isGuardPath(path: string): boolean {
  const base = lower(path.split("/").pop());
  if (lower(path).startsWith(AUTHORITY_PACKAGE) || CI_AND_SETTINGS.test(lower(path))) return true;
  if (base.startsWith("g10-") || base.startsWith("by-rec")) return true;
  return /(^|[-_.])(hold|policy|authority)([-_.]|$)/.test(base);
}

function guardTouched(subject: ByRecSubject): boolean {
  return subject.guardPath === true || (subject.paths ?? []).some(isGuardPath);
}

function namesMoney(subject: ByRecSubject): boolean {
  if (MONEY_CATEGORIES.has(lower(subject.category)) || hasFamily(subject.authorityRows, ["SPD"])) return true;
  return (subject.text ?? []).some((line) => DOLLAR_AMOUNT.test(line));
}

function authorityRowRefuses(subject: ByRecSubject): boolean {
  if (subject.authorityTable !== undefined && subject.authorityTable.trim() !== AUTHORITY_TABLE) return true;
  return (subject.authorityRows ?? []).some((row) => !AUTO_RESOLVABLE_FAMILIES.has(familyOf(row)));
}

/**
 * A recommendation with no offered options to check it against, that is not one of them, or that the asker's own
 * default contradicts.
 */
function answerUnsound(subject: ByRecSubject): boolean {
  const answer = subject.recommendation?.answer;
  if (answer === undefined) return false;
  if (subject.options === undefined || !subject.options.includes(answer)) return true;
  return subject.default !== undefined && subject.default !== answer;
}

/**
 * The exclusion floor, in code: a policy file can add exclusions but never remove one of these. Every rule refuses on
 * presence. The g10 rule matches by prefix, so a new g10 class fails closed, and the authority-row rule refuses every
 * family not on the auto-resolvable list, so a new table family fails closed.
 */
export const BY_REC_FLOOR: readonly FloorRule[] = [
  ["closed", (s) => s.closed === true],
  ["no-recommendation", (s) => s.recommendation === undefined],
  ["g10-hold", (s) => hasPrefix(s.holdClasses, ["g10"])],
  ["security-class", (s) => SECURITY_CLASSES.has(s.decisionClass ?? "")],
  ["guard-class", (s) => GUARD_CLASSES.has(s.decisionClass ?? "")],
  ["owner-at-head", (s) => (s.ownerAtHead ?? []).length > 0 || hasPrefix(s.holdClasses, [...OWNER_AT_HEAD_ROWS])],
  ["guard-path", guardTouched],
  ["release", (s) => releaseRef(s.headRef) || RELEASE_CATEGORIES.has(lower(s.category)) || hasFamily(s.authorityRows, ["REL"])],
  ["publish", (s) => hasFamily(s.authorityRows, ["PUB", "EXT"])],
  ["secret", (s) => hasFamily(s.authorityRows, ["SEC"])],
  ["hardware", (s) => hasFamily(s.authorityRows, ["HW", "HWS"])],
  ["money", namesMoney],
  ["authority-row", authorityRowRefuses],
  ["one-way", (s) => s.door === "one-way"],
  ["irreversible", (s) => s.irreversible === true],
  ["on-silence-wait", (s) => s.onSilence?.action === "wait"],
  ["on-silence-expire", (s) => s.onSilence?.action === "expire"],
  ["blind", (s) => s.blind === true],
  ["change-requested", (s) => s.changeRequested === true],
  ["personal", (s) => s.personal === true],
  ["not-a-decision", (s) => NOT_DECISIONS.has(lower(s.kind))],
  ["operator-audience", (s) => s.audience === "operator"],
  ["owner-op", (s) => s.op !== undefined],
  ["ship", (s) => s.ship === true],
  ["plan-approval", (s) => s.planApproval === true],
  ["answer-unsound", answerUnsound],
];

/** The first floor class the subject falls in, or undefined when none does. */
export function floorReason(subject: ByRecSubject): string | undefined {
  return BY_REC_FLOOR.find(([, refuses]) => refuses(subject))?.[0];
}
