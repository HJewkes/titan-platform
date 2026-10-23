import type { SpineCandidate } from "./audition-sample.js";
import type { MaterialFact } from "./material-facts.js";

// A cell is one table cell: a line break or a bare pipe in fact text would split the row.
const cell = (text: string): string => text.replace(/\s+/g, " ").trim().replace(/\|/g, "\\|");

const table = (header: readonly string[], rows: readonly (readonly string[])[]): string =>
  [`| ${header.join(" | ")} |`, `|${header.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`)].join("\n");

/** Each fact the spine cites, with the chapter that first shows it and the later chapters that show it again. */
function ledgerRows(spine: SpineCandidate): string[][] {
  const chapters = new Map<string, string[]>();
  const cite = (fact: string, chapter: string) => {
    const seen = chapters.get(fact) ?? [];
    if (!seen.includes(chapter)) chapters.set(fact, [...seen, chapter]);
  };
  cite(spine.hook.fact, "ch1");
  spine.blocks.forEach((block, i) => block.facts.forEach((fact) => cite(fact, `ch${i + 1}`)));
  return [...chapters].map(([fact, [first, ...later]]) => [fact, "concept", first!, later.join(", ") || "—"]);
}

/**
 * The audition pick as a `spine/v1` story spine (spine-schema.ts), for a profile whose spine comes from its audition:
 * block n is journey step n and chapter n, its question the step and the chapter question, its first fact the why.
 * Each block stands as its own part, and the ledger lists every cited fact by id at the chapter that first cites it.
 */
export function pickSpine(id: string, spine: SpineCandidate, facts: readonly MaterialFact[]): string {
  const text = new Map(facts.map((fact) => [fact.id, fact.text]));
  const journey = spine.blocks.map((block, i) => [String(i + 1), block.id, block.question, text.get(block.facts[0]!) ?? block.facts[0]!, "—", "—"]);
  const parts = spine.blocks.map((block, i) => [block.id, String(i + 1), "—", "—"]);
  const chapters = spine.blocks.map((block, i) => [`ch${i + 1}`, block.question, `§3.${i + 1}`]);
  return [
    `# Story spine: ${id}`,
    `${spine.sentence}\n\nHook: ${spine.hook.line}`,
    `## 3. Journey\n\n${table(["#", "Step", "What", "Why", "Invariant", "Today"], journey)}`,
    `## 4. Architecture\n\n${table(["Part", "Carries", "Mechanism", "Constraint"], parts)}`,
    `## 5. Constraints\n\n${table(["Constraint", "Forces"], [])}`,
    `## 6. Ledger\n\n${table(["Item", "Kind", "Defined in", "Reused in"], ledgerRows(spine))}`,
    `## 8. Chapter order\n\n${table(["Chapter", "Question", "Rows"], chapters)}`,
  ].join("\n\n") + "\n";
}
