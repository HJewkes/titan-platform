import { z } from "zod";
import type { Proposal } from "./schemas.js";

/** A ban is prose (`"..."`), `true` or a data object; any of them turns it on. `false` turns it off. */
const BanSchema = z.union([z.string(), z.boolean(), z.object({}).loose()]);
const LiteralBanSchema = z.union([z.string(), z.boolean(), z.object({ allowed: z.array(z.number()).optional() }).loose()]);

export const BoundsSchema = z.object({
  schema: z.literal("ar-bounds/v1"),
  classes: z.record(
    z.string(),
    z.object({
      paths: z.array(z.string()),
      tests: z.array(z.string()).default([]),
      params: z.record(z.string(), z.tuple([z.number(), z.number()])).optional(),
      /** Param keys, exact or `prefix.*`, whose values must be whole numbers. */
      integerParams: z.array(z.string()).default([]),
    }),
  ),
  /** Implied by the class allowlist: an idea has exactly one class. */
  diff: z.object({ oneClassPerIdea: z.boolean().default(true) }).default({ oneClassPerIdea: true }),
  test: z
    .object({ required: z.boolean().default(false), mustFailOnBase: z.boolean().default(false), exceptClasses: z.array(z.string()).default([]) })
    .default({ required: false, mustFailOnBase: false, exceptClasses: [] }),
  banned: z
    .object({ frozenTouch: BanSchema.optional(), literalsOutsideConfig: LiteralBanSchema.optional(), newFiles: BanSchema.optional(), seedNames: BanSchema.optional() })
    .default({}),
});
export type Bounds = z.infer<typeof BoundsSchema>;
export type ClassBounds = Bounds["classes"][string];

export const banOn = (ban: unknown): boolean => ban !== undefined && ban !== false;

/** `**`, `*`, `?` and `{a,b}` only: the shapes `bounds.json` uses. */
function globToRegExp(glob: string): RegExp {
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]!;
    if (glob.startsWith("**/", i)) {
      source += "(?:.*/)?";
      i += 2;
    } else if (glob.startsWith("**", i)) {
      source += ".*";
      i += 1;
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else if (char === "{") source += "(?:";
    else if (char === "}") source += ")";
    else if (char === ",") source += "|";
    else source += char.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

export const matchesAny = (path: string, globs: readonly string[]): boolean => globs.some((glob) => globToRegExp(glob).test(path));

/** An exact key wins over a `prefix.*` pattern. */
function keyPattern(patterns: readonly string[], key: string): string | undefined {
  if (patterns.includes(key)) return key;
  return patterns.find((pattern) => pattern.endsWith(".*") && key.startsWith(pattern.slice(0, -1)));
}

/** `null` stands for a key the change removed. */
export function paramCode(spec: ClassBounds, params: Record<string, unknown>): string | undefined {
  const ranges = spec.params ?? {};
  for (const [key, value] of Object.entries(params)) {
    if (value === null) return "param-removed";
    const pattern = keyPattern(Object.keys(ranges), key);
    if (!pattern || typeof value !== "number") return "param-unknown";
    const [low, high] = ranges[pattern]!;
    if (value < low || value > high) return "param-out-of-range";
    if (keyPattern(spec.integerParams, key) && !Number.isInteger(value)) return "param-not-integer";
  }
  return undefined;
}

/** `ar-bounds-pre`, run on every planner add before any spawn: a failure costs nothing but the planner's words. */
export function preCheck(proposal: Proposal, bounds: Bounds, caseNames: readonly string[]): string | undefined {
  const spec = bounds.classes[proposal.class];
  if (!spec) return "unknown-class";
  if (proposal.targets.length === 0 || !proposal.targets.every((target) => matchesAny(target, spec.paths))) return "target-outside-class";
  const params = paramCode(spec, proposal.params ?? {});
  if (params) return params;
  const text = JSON.stringify(proposal);
  if (caseNames.some((name) => text.includes(name))) return "case-name";
  return undefined;
}
