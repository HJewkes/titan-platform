/** Synthetic phase-2 files for the sheet tests: one digest, `web`, and a sheet builder over it. */

export const DIGEST = [
  "---",
  "schema: titan-intent-digest/v1",
  "slug: web",
  "initiative: alpha",
  "built_from: synthetic rows",
  "---",
  "## Standing direction",
  '- I1 2026-11-01 "the page answers from a phone" (quote: msg:aaa111)',
  "## Reasons",
  '- I2 2026-11-02 "the list is slow" (quote: msg:bbb222)',
  "## Ruled out",
  "## Taste",
  "## Open questions",
  "## Superseded",
  "",
].join("\n");

export const digests = (name: string): string | undefined => (name === "web" ? DIGEST : undefined);

interface SheetParts {
  front?: Record<string, string>;
  outcome?: string[];
  bets?: string[][];
}

const FRONT = { schema: "titan-bet-sheet/v1", slug: "web", initiative: "alpha", lane: "lane-a", week: "2026-W47", digest: "web", default_on_silence: "apply-proposed-order" };

const OUTCOME = ["outcome:", "  local: phone-first", "  statement: The page answers from a phone", "  measure: terminal scripts per week", "  owner_intent: { intent_ref: web/I1, quote_ref: msg:aaa111 }"];

/** A bet block's lines; each field can be replaced or dropped (`null`). */
export function betLines(local: string, order: number, fields: Record<string, string | null> = {}): string[] {
  const base: Record<string, string | null> = {
    tasks: "[alpha/AL-1, alpha/AL-2]",
    prediction: "{ metric: list_p50_s, direction: decrease, baseline: 8.4, expected: 2, read_by: 2026-11-28 }",
    cites: "[{ intent_ref: web/I2, quote_ref: msg:bbb222 }]",
    ...fields,
  };
  const rest = Object.entries(base).flatMap(([key, value]) => (value === null ? [] : [`  ${key}: ${value}`]));
  return ["bet:", `  local: ${local}`, `  order: ${order}`, ...rest];
}

const fenced = (lines: string[]): string[] => ["```yaml", ...lines, "```"];

/** The PLAN 5.3 shape: front matter, a prose line, the outcome block, then the bets in proposed order. */
export function sheetText(parts: SheetParts = {}): string {
  const front = Object.entries({ ...FRONT, ...parts.front }).map(([key, value]) => `${key}: ${value}`);
  const bets = parts.bets ?? [betLines("S1", 1)];
  return ["---", ...front, "---", "PROPOSED, NOT SELECTED. Prose here is for the owner.", "## Success statement", ...fenced(parts.outcome ?? OUTCOME), "## Bets (proposed order)", ...bets.flatMap(fenced), ""].join("\n");
}
