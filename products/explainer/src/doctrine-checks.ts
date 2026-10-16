import { PROMPT_ENFORCEMENTS, type DoctrineEnforcement, type DoctrineRegistry, type DoctrineRule } from "./doctrine-schema.js";
import { resolveRule, type RuleRegistry } from "./rules.js";

export const DOCTRINE_ISSUE_CODES = [
  "duplicate-id",
  "reserved-q-id",
  "missing-evidence",
  "missing-grade",
  "grade-not-in-evidence",
  "beat-rule-without-beats",
  "type-rule-without-target",
  "universal-rule-scoped",
  "param-missing",
  "unknown-vocabulary",
  "check-enforcement-mismatch",
  "token-enforcement-mismatch",
  "code-rule-in-prompt-enforcement",
  "unknown-qrule",
  "qrule-live-mismatch",
  "unknown-supersedes",
] as const;

export type DoctrineIssueCode = (typeof DOCTRINE_ISSUE_CODES)[number];

export interface DoctrineIssue {
  code: DoctrineIssueCode;
  rule: string;
  message: string;
}

type RuleCheck = (rule: DoctrineRule, registry: DoctrineRegistry, qRules: RuleRegistry) => DoctrineIssue[];

const issue = (code: DoctrineIssueCode, rule: DoctrineRule, message: string): DoctrineIssue => ({ code, rule: rule.id, message });
const has = (rule: DoctrineRule, ...kinds: DoctrineEnforcement[]): boolean => kinds.some((kind) => rule.enforcement.includes(kind));

/**
 * Code-enforced: a live check, or tokens that are all live. Such a rule never reaches a prompt; a
 * rule whose check or tokens are not live yet still does, as the fallback (plan R4).
 */
export const isCodeEnforced = (rule: DoctrineRule): boolean =>
  rule.check?.live === true || (rule.tokens !== undefined && rule.tokens.every((token) => token.live));

const reservedQId: RuleCheck = (rule) =>
  /^Q-/.test(rule.id) ? [issue("reserved-q-id", rule, `${rule.id}: the Q- prefix belongs to doctrine/rules.yaml`)] : [];

const missingEvidence: RuleCheck = (rule, { evidence }) =>
  rule.evidence.filter((id) => !evidence.has(id)).map((id) => issue("missing-evidence", rule, `${id} is not in evidence.tsv`));

function gradeMatchesEvidence(rule: DoctrineRule, { evidence }: DoctrineRegistry): DoctrineIssue[] {
  if (rule.evidence.length === 0) return [];
  if (!rule.grade) return [issue("missing-grade", rule, "a rule that cites evidence states its grade")];
  const cited = new Set(rule.evidence.flatMap((id) => evidence.get(id) ?? []));
  return cited.has(rule.grade)
    ? []
    : [issue("grade-not-in-evidence", rule, `grade ${rule.grade} is not among the cited rows' grades (${[...cited].join(", ") || "none"})`)];
}

function layerScope(rule: DoctrineRule): DoctrineIssue[] {
  const { layer, beats, types, audiences } = rule.scope;
  if (layer === "B" && !beats) return [issue("beat-rule-without-beats", rule, "a B rule names its beats")];
  if (layer === "T" && !types && !audiences) return [issue("type-rule-without-target", rule, "a T rule names its types or audiences")];
  if ((layer === "U" || layer === "U*") && (beats || types)) {
    return [issue("universal-rule-scoped", rule, `a ${layer} rule carries neither beats nor types`)];
  }
  return layer === "U*" && !rule.param ? [issue("param-missing", rule, "a U* rule names the profile param that supplies its value")] : [];
}

function vocabulary(rule: DoctrineRule, registry: DoctrineRegistry): DoctrineIssue[] {
  const { beats = [], types = [], audiences = [] } = rule.scope;
  const allowed = registry.vocabulary;
  const unknown = [
    ...beats.filter((name) => !allowed.beats.includes(name)).map((name) => `beat ${name}`),
    ...types.filter((name) => !allowed.types.includes(name)).map((name) => `type ${name}`),
    ...audiences.filter((name) => !allowed.audiences.includes(name)).map((name) => `audience ${name}`),
  ];
  return unknown.map((name) => issue("unknown-vocabulary", rule, `${name} is not in vocabulary.yaml`));
}

const checkMatchesEnforcement: RuleCheck = (rule) =>
  (rule.check !== undefined) === has(rule, "lint", "gate")
    ? []
    : [issue("check-enforcement-mismatch", rule, "a rule has a check exactly when its enforcement lists lint or gate")];

const tokensMatchEnforcement: RuleCheck = (rule) =>
  (rule.tokens !== undefined) === has(rule, "token")
    ? []
    : [issue("token-enforcement-mismatch", rule, "a rule has tokens exactly when its enforcement lists token")];

const codeRuleInPrompt: RuleCheck = (rule) =>
  isCodeEnforced(rule) && has(rule, ...PROMPT_ENFORCEMENTS)
    ? [issue("code-rule-in-prompt-enforcement", rule, "a code-enforced rule lists no planner, packet or base enforcement")]
    : [];

function qruleRef(rule: DoctrineRule, _registry: DoctrineRegistry, qRules: RuleRegistry): DoctrineIssue[] {
  if (rule.check?.kind !== "qrule") return [];
  const target = resolveRule(qRules, rule.check.ref);
  if (!target) return [issue("unknown-qrule", rule, `${rule.check.ref} names no rule in doctrine/rules.yaml`)];
  const implemented = target.l0?.status === "implemented";
  return implemented === rule.check.live
    ? []
    : [issue("qrule-live-mismatch", rule, `${rule.check.ref} L0 is ${implemented ? "implemented" : "not implemented"}, so live is ${implemented}`)];
}

const RULE_CHECKS: RuleCheck[] = [
  reservedQId,
  missingEvidence,
  gradeMatchesEvidence,
  layerScope,
  vocabulary,
  checkMatchesEnforcement,
  tokensMatchEnforcement,
  codeRuleInPrompt,
  qruleRef,
];

function registryIssues({ rules }: DoctrineRegistry): DoctrineIssue[] {
  const counts = new Map<string, number>();
  rules.forEach((rule) => counts.set(rule.id, (counts.get(rule.id) ?? 0) + 1));
  const duplicates = [...counts].filter(([, count]) => count > 1).map(([id]) => ({ code: "duplicate-id" as const, rule: id, message: `${id} names more than one rule` }));
  const unresolved = rules.flatMap((rule) =>
    (rule.supersedes ?? []).filter((id) => !counts.has(id)).map((id) => issue("unknown-supersedes", rule, `supersedes ${id}, which names no rule`)),
  );
  return [...duplicates, ...unresolved];
}

/** Every refinement over a loaded registry, against the Q-rule registry its qrule checks cite. Empty when sound. */
export function checkDoctrine(registry: DoctrineRegistry, qRules: RuleRegistry): DoctrineIssue[] {
  return [...registryIssues(registry), ...registry.rules.flatMap((rule) => RULE_CHECKS.flatMap((check) => check(rule, registry, qRules)))];
}
