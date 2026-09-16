/**
 * Turning a long trigger text into a query.
 *
 * A spawn brief runs to thousands of characters and an FTS engine ORs every
 * token, so handing it over whole ranks on document length rather than on
 * subject. Which words to keep is therefore a real design decision, and the
 * harness measures two answers rather than assuming one.
 */

/** Matches everything and therefore ranks nothing; the same list the bootstrap ranker drops. */
const STOP_WORDS = new Set(
  (
    "a an and are as at be but by for from in into is it of on or the to with via than then that " +
    "this these those over under new old add fix use using not no all any each per you your it's " +
    "will can should must do does have has was were been they them their there here what when"
  ).split(" "),
);

export function terms(text: string): string[] {
  const tokens = text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  return tokens.filter((token) => token.length > 2 && !STOP_WORDS.has(token));
}

const LEAD_WORDS = 30;

/**
 * Variant A: the first heading plus the opening of the body.
 *
 * Cheap, order-preserving, and the closest thing to what a human would skim.
 * It assumes the writer front-loaded the subject, which is the convention these
 * briefs follow and the thing the comparison is there to test.
 */
export function headingAndLead(text: string, leadWords = LEAD_WORDS): string {
  const lines = text.split("\n");
  const heading = lines.find((line) => /^#{1,6}\s+\S/.test(line.trim()))?.replace(/^#+\s*/, "").trim();
  const body = lines
    .filter((line) => !/^#{1,6}\s/.test(line.trim()))
    .join(" ");
  const lead = terms(body).slice(0, leadWords).join(" ");
  return [heading, lead].filter((part) => part && part.length > 0).join(" ").trim();
}

/** Per-term document frequency over the corpus a query is drawn from. */
export function documentFrequency(documents: string[]): Map<string, number> {
  const df = new Map<string, number>();
  for (const document of documents) {
    for (const term of new Set(terms(document))) df.set(term, (df.get(term) ?? 0) + 1);
  }
  return df;
}

const TOP_TERMS = 12;

/**
 * Variant B: the rarest terms this text uses, by corpus document frequency.
 *
 * Position-blind, so a subject stated halfway down still surfaces. Ties break
 * on in-document frequency and then on first appearance, which keeps the output
 * deterministic across runs — a query that reshuffles would make the eval
 * unreproducible for no gain.
 */
export function topTermsByDf(text: string, df: Map<string, number>, limit = TOP_TERMS): string {
  const local = new Map<string, number>();
  const order = new Map<string, number>();
  terms(text).forEach((term, index) => {
    local.set(term, (local.get(term) ?? 0) + 1);
    if (!order.has(term)) order.set(term, index);
  });
  return [...local.keys()]
    .sort((a, b) => rarity(a, df) - rarity(b, df) || local.get(b)! - local.get(a)! || order.get(a)! - order.get(b)!)
    .slice(0, limit)
    .join(" ");
}

/** An unseen term is the rarest thing there is, so treat a missing count as 0. */
function rarity(term: string, df: Map<string, number>): number {
  return df.get(term) ?? 0;
}

export type QueryVariant = "heading-lead" | "top-df";
export const QUERY_VARIANTS: QueryVariant[] = ["heading-lead", "top-df"];

export function deriveQuery(variant: QueryVariant, text: string, df: Map<string, number>): string {
  return variant === "heading-lead" ? headingAndLead(text) : topTermsByDf(text, df);
}
