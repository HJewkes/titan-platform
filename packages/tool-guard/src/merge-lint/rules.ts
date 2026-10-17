import { z } from "zod";

const REASON = z.string().min(1);
const COVERS_EVERYTHING = new Set(["*", "**", "**/*", "**/**"]);

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

/** An entry that covers every path would let any merge call through, so it is refused rather than honoured. */
function coverAllProblem(rules: Rules): string | null {
  const wide = rules.allow.find((entry) => COVERS_EVERYTHING.has(entry.path));
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
