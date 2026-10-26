import type { L0Check } from "./eval-l0.js";
import { claimsCheck, claimsCheckWith, type GatheredFact } from "./lint-claims.js";
import { parseFacts } from "./material-facts.js";

const isFact = (value: unknown): value is GatheredFact =>
  typeof value === "object" && value !== null && typeof (value as { id?: unknown }).id === "string";

function digestItems(text: string): GatheredFact[] | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    const items = typeof parsed === "object" && parsed !== null ? (parsed as { items?: unknown }).items : undefined;
    return Array.isArray(items) ? items.filter(isFact) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The facts Q-E20 checks a script against: a daily gather's `digest.json` items with every field, else the rows of a
 * facts pack (`facts.md`, or JSON lines). Text that holds neither gives none, and Q-E20 reports that it did not run.
 */
export function claimFacts(text: string): GatheredFact[] | undefined {
  const items = digestItems(text);
  if (items) return items;
  try {
    return parseFacts(text).facts.map((fact) => ({ ...fact }));
  } catch {
    return undefined;
  }
}

/** `checks` with the registered no-facts Q-E20 swapped for one that reads `facts`; any other list is kept as is. */
export const withClaimFacts = (checks: readonly L0Check[], facts: readonly GatheredFact[] | undefined): readonly L0Check[] =>
  facts?.length ? checks.map((check) => (check === claimsCheck ? claimsCheckWith(facts) : check)) : checks;
