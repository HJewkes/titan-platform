import { z } from "zod";
import { ALWAYS_ASK, type AlwaysAskEntry } from "./always-ask.js";
import { DEFAULT_MIN_CONFIDENCE } from "./contract.js";
import { normalizeKey } from "./normalize.js";
import { UNLOCK_CATEGORIES } from "./unlock.js";

export const DECIDER_MODES = ["off", "shadow", "auto"] as const;
export type DeciderMode = (typeof DECIDER_MODES)[number];

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

/** Always-ask and unlock-table categories: their mode is `off` and nothing raises it. */
export function isLockedCategory(category: string, list: readonly AlwaysAskEntry[] = ALWAYS_ASK): boolean {
  const key = normalizeKey(category);
  return [...list.map((entry) => entry.id), ...UNLOCK_CATEGORIES].some((id) => normalizeKey(id) === key);
}

/** A parsed policy with category names normalized and every locked one forced to `off`, so stored data cannot raise one. */
export function parseRoutingPolicy(input: unknown): RoutingPolicy {
  const policy = RoutingPolicySchema.parse(input);
  return {
    ...policy,
    categories: policy.categories.map((row) => {
      const category = normalizeKey(row.category);
      return { ...row, category, mode: isLockedCategory(category) ? ("off" as const) : row.mode };
    }),
  };
}

/** The category's row, or the defaults: every category starts in shadow, locked ones off. */
export function categoryPolicy(policy: RoutingPolicy, category: string): CategoryPolicy {
  const key = normalizeKey(category);
  const row =
    policy.categories.find((c) => normalizeKey(c.category) === key) ?? CategoryPolicySchema.parse({ category: key });
  return { ...row, category: key, mode: isLockedCategory(key) ? "off" : row.mode };
}

/** A new policy with the category at `mode`; raising a locked category above `off` throws. */
export function setCategoryMode(policy: RoutingPolicy, category: string, mode: DeciderMode): RoutingPolicy {
  if (mode !== "off" && isLockedCategory(category))
    throw new Error(`category "${category}" is always-ask and stays off`);
  const row = { ...categoryPolicy(policy, category), category: normalizeKey(category), mode };
  const rest = policy.categories.filter((c) => normalizeKey(c.category) !== row.category);
  return { ...policy, categories: [...rest, row] };
}
