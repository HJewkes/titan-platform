import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { z } from "zod";
import { loadStructures, loadTypeProfiles } from "./profile-load.js";

/** The shipped registry. src/ and dist/ both sit one level under the package root. */
export const DEFAULT_RULES_PATH = fileURLToPath(new URL("../doctrine/rules.yaml", import.meta.url));

const Id = z.string().min(1);
const Slice = z.string().regex(/^(SQ\d+|TP-\d+)$/, "expected the owning slice or task, e.g. SQ3 or TP-2988");

const L0Pending = z.object({ severity: z.enum(["error", "warning"]), status: z.literal("pending"), owner: Slice, partial: z.array(Id).default([]) }).strict();
/** Where a rule's check measures: `chapter` reads each chapter's own beats, `video` (also when absent) the whole script. */
export const RULE_SCOPES = ["chapter", "video"] as const;
const L0Implemented = z
  .object({
    severity: z.enum(["error", "warning"]),
    status: z.literal("implemented"),
    checks: z.array(Id).min(1),
    structures: z.array(Id).min(1).optional(),
    except_profiles: z.array(Id).min(1).optional(),
    scope: z.enum(RULE_SCOPES).optional(),
  })
  .strict();
const JudgePending = z.object({ layer: z.enum(["L1", "L2"]), status: z.literal("pending"), owner: Slice }).strict();
const JudgeCited = z.object({ layer: z.enum(["L1", "L2"]), status: z.literal("cited"), rubric: Id }).strict();

const RuleSchema = z
  .object({
    id: z.string().regex(/^Q-[VWFDE]\d+$/, "expected a Q-rule id such as Q-V1"),
    rule: z.string().min(1),
    fields: z.array(Id).min(1),
    aliases: z.array(Id).default([]),
    related: z.array(Id).default([]),
    rubric_dims: z.array(z.string().regex(/^[BJ]\d+$/)).default([]),
    owner_support: z.enum(["none", "for", "against"]),
    note: z.string().min(1).optional(),
    l0: z.discriminatedUnion("status", [L0Pending, L0Implemented]).optional(),
    judge: z.discriminatedUnion("status", [JudgePending, JudgeCited]).optional(),
  })
  .strict()
  .refine((rule) => rule.l0 || rule.judge, { message: "a rule needs an l0 check, a judge check, or both" });

export type Rule = z.infer<typeof RuleSchema>;
export type CheckType = "L0" | "J" | "L0+J";

function checkIdentity(registry: { rules: Rule[] }, ctx: z.RefinementCtx): void {
  const owner = new Map<string, string>();
  const claim = (name: string, by: string, path: (string | number)[]): void => {
    const prior = owner.get(name);
    if (prior) ctx.addIssue({ code: "custom", path, message: `${name} already names ${prior}` });
    else owner.set(name, by);
  };
  registry.rules.forEach((rule, i) => claim(rule.id, rule.id, ["rules", i, "id"]));
  registry.rules.forEach((rule, i) => rule.aliases.forEach((alias, j) => claim(alias, rule.id, ["rules", i, "aliases", j])));
}

/** `rules/v1`: one id space; every id and alias names exactly one rule. */
export const RuleRegistrySchema = z
  .object({ schema: z.literal("rules/v1"), rules: z.array(RuleSchema).min(1) })
  .strict()
  .superRefine(checkIdentity);

export type RuleRegistry = z.infer<typeof RuleRegistrySchema>;

/** The structures and video type profiles a rule's scope may name. */
export interface ScopeNames {
  structures: ReadonlySet<string>;
  profiles: ReadonlySet<string>;
}

function unknownNames(id: string, kind: string, names: readonly string[] | undefined, known: ReadonlySet<string>): string[] {
  return (names ?? []).filter((name) => !known.has(name)).map((name) => `${id}: unknown ${kind} ${name}`);
}

/** A rule scoped to a structure or profile the registry does not hold would silently never run, or never be exempt, so it is refused. */
function checkScopes(registry: RuleRegistry, known: ScopeNames): RuleRegistry {
  const unknown = registry.rules.flatMap(({ id, l0 }) =>
    l0?.status === "implemented"
      ? [...unknownNames(id, "structure", l0.structures, known.structures), ...unknownNames(id, "profile", l0.except_profiles, known.profiles)]
      : [],
  );
  if (unknown.length > 0) throw new Error(unknown.join("; "));
  return registry;
}

export const parseRuleRegistry = (text: string, known?: ScopeNames): RuleRegistry => {
  const registry = RuleRegistrySchema.parse(parse(text));
  return known ? checkScopes(registry, known) : registry;
};

export const loadRuleRegistry = (path: string = DEFAULT_RULES_PATH): RuleRegistry =>
  parseRuleRegistry(readFileSync(path, "utf8"), { structures: new Set(loadStructures().keys()), profiles: new Set(loadTypeProfiles().keys()) });

let shipped: RuleRegistry | undefined;
/** The shipped registry, read once; the L0 runner scopes its rows by it. */
export const shippedRuleRegistry = (): RuleRegistry => (shipped ??= loadRuleRegistry());

/** What a rule's scope reads off a script. A legacy script names no structure. */
export interface ScriptScope {
  structure?: string | undefined;
  profile?: string | undefined;
}

type ImplementedL0 = z.infer<typeof L0Implemented>;

const scopedAway = (l0: ImplementedL0, { structure, profile }: ScriptScope): boolean =>
  (structure !== undefined && l0.structures !== undefined && !l0.structures.includes(structure)) ||
  (profile !== undefined && (l0.except_profiles ?? []).includes(profile));

/**
 * The check ids of rules scoped away from this script: a `structures` list that leaves its structure out, or an
 * `except_profiles` list that names its profile. A rule with neither applies to every script.
 */
export function checksScopedAway(registry: RuleRegistry, script: ScriptScope): Set<string> {
  return new Set(registry.rules.flatMap(({ l0 }) => (l0?.status === "implemented" && scopedAway(l0, script) ? l0.checks : [])));
}

/** The check ids of chapter-scoped rules: a chapter's verdict on them does not depend on the chapters after it. */
export const chapterScopedChecks = (registry: RuleRegistry): Set<string> =>
  new Set(registry.rules.flatMap(({ l0 }) => (l0?.status === "implemented" && l0.scope === "chapter" ? l0.checks : [])));

export const checkType = (rule: Rule): CheckType => (rule.l0 && rule.judge ? "L0+J" : rule.l0 ? "L0" : "J");

/**
 * The L0 rules whose claimed check ids are not among the ids the registered checks emit. A
 * pending rule owes nothing yet, but a `partial` id it names must still exist.
 */
export function unimplementedL0Rules(registry: RuleRegistry, emitted: ReadonlySet<string>): string[] {
  return registry.rules
    .filter(({ l0 }) => l0 && (l0.status === "implemented" ? l0.checks : l0.partial).some((id) => !emitted.has(id)))
    .map((rule) => rule.id);
}

/**
 * The emitted check ids shaped like a Q-rule id that no rule claims as implemented: a lint that
 * landed while its rule stayed pending, or one emitting an id the registry does not hold.
 */
export function unclaimedL0Checks(registry: RuleRegistry, emitted: ReadonlySet<string>): string[] {
  const claimed = new Set(registry.rules.flatMap(({ l0 }) => (l0?.status === "implemented" ? l0.checks : [])));
  return [...emitted].filter((id) => /^Q-[VWFDE]\d+$/.test(id) && !claimed.has(id)).sort();
}

/** Resolves a Q-id or a phase-1 alias to its rule; `related` ids are citations only and never resolve. */
export function resolveRule(registry: RuleRegistry, idOrAlias: string): Rule | undefined {
  return registry.rules.find((rule) => rule.id === idOrAlias || rule.aliases.includes(idOrAlias));
}
