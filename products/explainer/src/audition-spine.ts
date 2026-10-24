import type { SpineCandidate } from "./audition-sample.js";
import type { MaterialFact } from "./material-facts.js";

// A cell is one table cell: a line break or a bare pipe in fact text would split the row.
const cell = (text: string): string => text.replace(/\s+/g, " ").trim().replace(/\|/g, "\\|");

const table = (header: readonly string[], rows: readonly (readonly string[])[]): string =>
  [`| ${header.join(" | ")} |`, `|${header.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`)].join("\n");

// The handle a script speaks for a fact: a task fact (`task/<id>/<change>`) by its task id, a pull-request fact
// (`pr/<repo>#<n>/<change>`) as "PR <n>". Any other fact is named by its id.
const TASK_FACT = /^task\/([^/]+)\/[^/]+$/;
const PR_FACT = /^pr\/.+#(\d+)\/[^/]+$/;
export function spokenHandle(factId: string): string {
  const task = TASK_FACT.exec(factId)?.[1];
  if (task) return task;
  const pr = PR_FACT.exec(factId)?.[1];
  return pr ? `PR ${pr}` : factId;
}

interface Cited {
  facts: string[];
  chapters: string[];
}

/** Each handle the spine cites, with its fact ids, the chapter that first shows it and the later chapters that show it again. */
function citations(spine: SpineCandidate): Map<string, Cited> {
  const cited = new Map<string, Cited>();
  const cite = (fact: string, chapter: string) => {
    const seen = cited.get(spokenHandle(fact)) ?? { facts: [], chapters: [] };
    if (!seen.facts.includes(fact)) seen.facts.push(fact);
    if (!seen.chapters.includes(chapter)) seen.chapters.push(chapter);
    cited.set(spokenHandle(fact), seen);
  };
  cite(spine.hook.fact, spine.blocks[0]!.id);
  spine.blocks.forEach((block) => block.facts.forEach((fact) => cite(fact, block.id)));
  return cited;
}

const ledgerRows = (cited: Map<string, Cited>): string[][] =>
  [...cited].map(([handle, { chapters: [first, ...later] }]) => [handle, "concept", first!, later.join(", ") || "—"]);

const citeRows = (cited: Map<string, Cited>): string[][] => [...cited].map(([handle, { facts }]) => [handle, facts.join(", ")]);

/**
 * The audition pick as a `spine/v1` story spine (spine-schema.ts), for a profile whose spine comes from its audition:
 * block n is journey step n and chapter n, its question the step and the chapter question, its first fact the why.
 * A chapter takes its block's id, so a later step can find a block's chapter (the daily's reflection) by name.
 * Each block stands as its own part and names its lead beat in §8. The ledger lists every cited fact by the handle a
 * script speaks for it, at the chapter that first cites it; the unnumbered Cites table keeps the fact ids to cite.
 */
export function pickSpine(id: string, spine: SpineCandidate, facts: readonly MaterialFact[]): string {
  const text = new Map(facts.map((fact) => [fact.id, fact.text]));
  const journey = spine.blocks.map((block, i) => [String(i + 1), block.id, block.question, text.get(block.facts[0]!) ?? block.facts[0]!, "—", "—"]);
  const parts = spine.blocks.map((block, i) => [block.id, String(i + 1), "—", "—"]);
  const chapters = spine.blocks.map((block, i) => [block.id, block.question, `§3.${i + 1}`, block.beat]);
  const cited = citations(spine);
  return [
    `# Story spine: ${id}`,
    `Structure: ${spine.structure}\n\n${spine.sentence}\n\nHook: ${spine.hook.line}`,
    `## 3. Journey\n\n${table(["#", "Step", "What", "Why", "Invariant", "Today"], journey)}`,
    `## 4. Architecture\n\n${table(["Part", "Carries", "Mechanism", "Constraint"], parts)}`,
    `## 5. Constraints\n\n${table(["Constraint", "Forces"], [])}`,
    `## 6. Ledger\n\n${table(["Item", "Kind", "Defined in", "Reused in"], ledgerRows(cited))}`,
    `## Cites\n\n${table(["Item", "Facts"], citeRows(cited))}`,
    `## 8. Chapter order\n\n${table(["Chapter", "Question", "Rows", "Beat"], chapters)}`,
  ].join("\n\n") + "\n";
}
