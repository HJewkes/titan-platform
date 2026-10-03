import { z } from "zod";
import { ALWAYS_ASK, type AlwaysAskEntry } from "./always-ask.js";
import { DEFAULT_MIN_CONFIDENCE } from "./contract.js";
import { normalizeKey } from "./normalize.js";
import { UNLOCK_CATEGORIES } from "./unlock.js";

export const DECIDER_MODES = ["off", "shadow", "auto"] as const;
export type DeciderMode = (typeof DECIDER_MODES)[number];

/** Higher is more restrictive; folded policy rows keep the highest. */
export const MODE_RESTRICTIVENESS: Readonly<Record<DeciderMode, number>> = {
  auto: 0,
  shadow: 1,
  off: 2,
};

export function strictestMode(a: DeciderMode, b: DeciderMode): DeciderMode {
  return MODE_RESTRICTIVENESS[b] > MODE_RESTRICTIVENESS[a] ? b : a;
}

/** Rows that normalize to one key collapse to the first, carrying the strictest mode among them. */
function foldRows(rows: readonly CategoryPolicy[]): CategoryPolicy[] {
  const folded = new Map<string, CategoryPolicy>();
  for (const row of rows) {
    const key = categoryKey(row.category);
    const seen = folded.get(key);
    folded.set(
      key,
      seen === undefined
        ? { ...row, category: key }
        : { ...seen, mode: strictestMode(seen.mode, row.mode) }
    );
  }
  return [...folded.values()];
}

export const CategoryPolicySchema = z.object({
  category: z.string().min(1),
  mode: z.enum(DECIDER_MODES).default("shadow"),
  minConfidence: z.number().min(0).max(1).default(DEFAULT_MIN_CONFIDENCE),
  windowDays: z.number().int().positive().default(30),
  minSamples: z.number().int().nonnegative().default(20),
  minAgreement: z.number().min(0).max(1).default(0.9),
  maxMissedRedirects: z.number().int().nonnegative().default(1),
});
export type CategoryPolicy = z.output<typeof CategoryPolicySchema>;

export const RoutingPolicySchema = z.object({
  categories: z.array(CategoryPolicySchema).default([]),
  hardStops: z.array(z.string()).default([]),
  humanOnlyInitiatives: z.array(z.string()).default([]),
});
export type RoutingPolicy = z.output<typeof RoutingPolicySchema>;

/** The normalized key, or the trimmed lowercase text when normalizing would empty it, so a symbol-only name never collapses to "". */
export function categoryKey(text: string): string {
  return normalizeKey(text) || text.trim().toLowerCase();
}

/** Always-ask and unlock-table categories: their mode is `off` and nothing raises it. */
export function isLockedCategory(
  category: string,
  list: readonly AlwaysAskEntry[] = ALWAYS_ASK
): boolean {
  const key = categoryKey(category);
  return [...list.map((entry) => entry.id), ...UNLOCK_CATEGORIES].some(
    (id) => categoryKey(id) === key
  );
}

/** A parsed policy with category names normalized and every locked one forced to `off`, so stored data cannot raise one. */
export function parseRoutingPolicy(input: unknown): RoutingPolicy {
  const policy = RoutingPolicySchema.parse(input);
  return {
    ...policy,
    categories: foldRows(policy.categories).map((row) => ({
      ...row,
      mode: isLockedCategory(row.category) ? ("off" as const) : row.mode,
    })),
  };
}

/** The category's row, or the defaults: every category starts in shadow, locked ones off. */
export function categoryPolicy(
  policy: RoutingPolicy,
  category: string
): CategoryPolicy {
  const key = categoryKey(category);
  const row =
    foldRows(policy.categories).find((c) => c.category === key) ??
    CategoryPolicySchema.parse({ category: key });
  return {
    ...row,
    category: key,
    mode: isLockedCategory(key) ? "off" : row.mode,
  };
}

/** A new policy with the category at `mode`; raising a locked category above `off` throws. */
export function setCategoryMode(
  policy: RoutingPolicy,
  category: string,
  mode: DeciderMode
): RoutingPolicy {
  if (mode !== "off" && isLockedCategory(category))
    throw new Error(`category "${category}" is always-ask and stays off`);
  const row = {
    ...categoryPolicy(policy, category),
    category: categoryKey(category),
    mode,
  };
  const rest = policy.categories.filter(
    (c) => categoryKey(c.category) !== row.category
  );
  return { ...policy, categories: [...rest, row] };
}
