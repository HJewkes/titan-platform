import { isCodeEnforced } from "./doctrine-checks.js";
import type { DoctrineEnforcement, DoctrineRegistry, DoctrineRule, DoctrineStage } from "./doctrine-schema.js";
import { resolveRule, type Rule, type RuleRegistry } from "./rules.js";

export interface StageRequest {
  stage: DoctrineStage;
  type?: string;
  audience?: string;
  /** The beats the stage works on; only B rules for these reach `prompt` or `packet`. */
  beats?: string[];
}

/** The rule half of one stage's slice (VT §5.4). Every list is sorted by rule id. */
export interface StageSlice {
  prompt: DoctrineRule[];
  base: DoctrineRule[];
  packet: DoctrineRule[];
  checks: DoctrineRule[];
  tokens: string[];
  params: string[];
}

export interface PromptLeak {
  rule: string;
  matched: string;
}

const isImplemented = (rule: Rule | undefined): boolean => rule?.l0?.status === "implemented";

/**
 * Also reads the Q-registry, so a `qrule` check whose `live` flag lags an implemented L0 still
 * keeps its rule out of every prompt; `checkDoctrine` reports the stale flag separately.
 */
const codeEnforced = (rule: DoctrineRule, qRules: RuleRegistry): boolean =>
  isCodeEnforced(rule) || (rule.check?.kind === "qrule" && isImplemented(resolveRule(qRules, rule.check.ref)));

const enforcedBy = (rule: DoctrineRule, ...kinds: DoctrineEnforcement[]): boolean => kinds.some((kind) => rule.enforcement.includes(kind));

const isUniversal = ({ scope }: DoctrineRule): boolean => scope.layer === "U" || scope.layer === "U*";

const matchesTarget = ({ scope }: DoctrineRule, { type, audience }: StageRequest): boolean =>
  scope.layer === "T" && ((type !== undefined && (scope.types ?? []).includes(type)) || (audience !== undefined && (scope.audiences ?? []).includes(audience)));

const matchesBeats = ({ scope }: DoctrineRule, { beats = [] }: StageRequest): boolean =>
  scope.layer === "B" && (scope.beats ?? []).some((beat) => beats.includes(beat));

const inScope = (rule: DoctrineRule, request: StageRequest): boolean =>
  isUniversal(rule) || matchesTarget(rule, request) || matchesBeats(rule, request);

const byId = (a: DoctrineRule, b: DoctrineRule): number => a.id.localeCompare(b.id);

function promptRules(rules: DoctrineRule[], request: StageRequest): DoctrineRule[] {
  const { stage } = request;
  if (stage === "plan") return rules.filter((rule) => (isUniversal(rule) || matchesTarget(rule, request)) && enforcedBy(rule, "planner"));
  if (stage === "script") return rules.filter((rule) => inScope(rule, request));
  if (stage === "publish") return rules.filter((rule) => inScope(rule, request) && enforcedBy(rule, "human", "planner"));
  return [];
}

const uniqueSorted = (names: (string | undefined)[]): string[] => [...new Set(names.filter((name) => name !== undefined))].sort();

/**
 * The rules one pipeline stage loads, for one video type, audience and set of beats. Gather and
 * select load no prose; render loads token names only. A code-enforced rule never lands in
 * `prompt`, `base` or `packet`, whichever enforcement it lists.
 */
export function sliceForStage(registry: DoctrineRegistry, qRules: RuleRegistry, request: StageRequest): StageSlice {
  const { stage } = request;
  const staged = registry.rules.filter((rule) => rule.stages.includes(stage)).sort(byId);
  const proseable = staged.filter((rule) => !codeEnforced(rule, qRules));
  const building = stage === "build";
  const prompt = promptRules(proseable, request);
  const base = building ? proseable.filter((rule) => isUniversal(rule) && enforcedBy(rule, "base")) : [];
  const packet = building ? proseable.filter((rule) => matchesBeats(rule, request) && enforcedBy(rule, "packet")) : [];
  const checks = stage === "qa" ? registry.rules.filter((rule) => rule.check !== undefined).sort(byId) : [];
  const tokenRules = building || stage === "render" ? staged.filter((rule) => inScope(rule, request)) : [];
  const tokens = uniqueSorted(tokenRules.flatMap((rule) => (rule.tokens ?? []).map((token) => token.name)));
  const params = uniqueSorted([...prompt, ...base, ...packet, ...checks].map((rule) => rule.param));
  return { prompt, base, packet, checks, tokens, params };
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** An id or alias as a whole token, so `Q-V1` does not match inside `Q-V10` or `dir-P1` inside `dir-P1.2`. */
const containsName = (text: string, name: string): boolean => new RegExp(`(?<![\\w.-])${escapeRegExp(name)}(?![\\w-]|\\.\\d)`).test(text);

function firstMatch(text: string, rule: string, names: string[], prose: string): PromptLeak[] {
  const name = names.find((candidate) => containsName(text, candidate));
  if (name !== undefined) return [{ rule, matched: name }];
  return text.includes(prose) ? [{ rule, matched: prose }] : [];
}

/**
 * The code-enforced rules of either registry that a prompt names by id, alias or exact text: a
 * doctrine rule with a live check or all-live tokens, or a Q-rule whose L0 is implemented. Token
 * names are not leaks, since prompts may cite them.
 */
export function findPromptLeaks(text: string, registry: DoctrineRegistry, qRules: RuleRegistry): PromptLeak[] {
  const doctrine = registry.rules
    .filter((rule) => codeEnforced(rule, qRules))
    .flatMap((rule) => firstMatch(text, rule.id, [rule.id], rule.text));
  const quality = qRules.rules.filter(isImplemented).flatMap((rule) => firstMatch(text, rule.id, [rule.id, ...rule.aliases], rule.rule));
  return [...doctrine, ...quality].sort((a, b) => a.rule.localeCompare(b.rule));
}
