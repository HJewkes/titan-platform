import { z } from "zod";
import type { Proposal } from "./schemas.js";

export const BoundsSchema = z.object({
  schema: z.literal("ar-bounds/v1"),
  classes: z.record(
    z.string(),
    z.object({
      paths: z.array(z.string()),
      tests: z.array(z.string()).default([]),
      params: z.record(z.string(), z.tuple([z.number(), z.number()])).optional(),
    }),
  ),
});
export type Bounds = z.infer<typeof BoundsSchema>;

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

const matchesAny = (path: string, globs: readonly string[]): boolean => globs.some((glob) => globToRegExp(glob).test(path));

/** An exact key wins over a `prefix.*` range. */
function paramRange(ranges: Record<string, [number, number]>, key: string): [number, number] | undefined {
  if (ranges[key]) return ranges[key];
  const wildcard = Object.keys(ranges).find((pattern) => pattern.endsWith(".*") && key.startsWith(pattern.slice(0, -1)));
  return wildcard ? ranges[wildcard] : undefined;
}

function paramCode(ranges: Record<string, [number, number]> | undefined, params: Record<string, number>): string | undefined {
  for (const [key, value] of Object.entries(params)) {
    const range = ranges ? paramRange(ranges, key) : undefined;
    if (!range) return "param-unknown";
    if (value < range[0] || value > range[1]) return "param-out-of-range";
  }
  return undefined;
}

/** `ar-bounds-pre`, run on every planner add before any spawn: a failure costs nothing but the planner's words. */
export function preCheck(proposal: Proposal, bounds: Bounds, seedNames: readonly string[]): string | undefined {
  const spec = bounds.classes[proposal.class];
  if (!spec) return "unknown-class";
  if (proposal.targets.length === 0 || !proposal.targets.every((target) => matchesAny(target, spec.paths))) return "target-outside-class";
  const params = paramCode(spec.params, proposal.params ?? {});
  if (params) return params;
  const text = JSON.stringify(proposal);
  if (seedNames.some((name) => text.includes(name))) return "seed-name";
  return undefined;
}
