import { z } from "zod";
import { globToRegExp } from "./scan.js";

const REASON = z.string().min(1);
/** A glob that matches every one of these covers the whole tree, however it is spelled (a doubled double-star segment, or a star segment then a double-star). */
const PROBE_PATHS = ["a", "a.ts", ".github/x.json", "a/b", "a/b/c/d.md", "packages/x/src/y.ts"];

const base = {
  path: z.string().min(1),
  /** When set, the entry covers only hit lines containing this exact text. */
  text: z.string().min(1).optional(),
  reason: REASON,
};

const AllowEntry = z.discriminatedUnion("kind", [
  z.strictObject({ ...base, kind: z.literal("wrapper"), mergePath: z.string().min(1), logs: z.boolean() }),
  z.strictObject({ ...base, kind: z.literal("detector") }),
  z.strictObject({ ...base, kind: z.literal("deny-list") }),
]);

export const RulesSchema = z.strictObject({
  $schema: z.literal("merge-lint/1"),
  level: z.enum(["warn", "error"]),
  scan: z.strictObject({ include: z.array(z.string()), brief: z.array(z.string()) }),
  exclude: z.array(z.string()),
  allow: z.array(AllowEntry),
});

export type Rules = z.infer<typeof RulesSchema>;
export type AllowEntryType = Rules["allow"][number];

export type RulesResult = { ok: true; rules: Rules } | { ok: false; error: string };

function covers(glob: string): boolean {
  if (/^[*/]+$/.test(glob)) return true;
  const regexp = globToRegExp(glob);
  return PROBE_PATHS.every((probe) => regexp.test(probe));
}

/** An entry that covers every path would let any merge call through, so it is refused rather than honoured. */
function coverAllProblem(rules: Rules): string | null {
  const wide = rules.allow.find((entry) => covers(entry.path));
  return wide ? `allow entry path "${wide.path}" covers every file` : null;
}

export function parseRules(source: string): RulesResult {
  let json: unknown;
  try {
    json = JSON.parse(source);
  } catch {
    return { ok: false, error: "not valid JSON" };
  }
  const parsed = RulesSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, error: `${issue?.path.join(".") || "(root)"}: ${issue?.message ?? "invalid"}` };
  }
  const problem = coverAllProblem(parsed.data);
  return problem ? { ok: false, error: problem } : { ok: true, rules: parsed.data };
}
