import { readTsv } from "./tsv.js";

/** Something a repo review proposed that must end with a disposition row. */
export interface ReviewItem {
  id: string;
  source: "recommendation" | "topic";
  /** 1-based line in SUMMARY.md for a recommendation, in topics-judged.tsv for a topic. */
  line: number;
}

const RECOMMENDATIONS_HEADING = /^##\s+(?:integration\s+)?recommendations\b/i;
const SECTION_END = /^#{1,2}\s/;
const FENCE = /^\s*(?:```|~~~)/;
const TOP_LEVEL_BULLET = /^(?:[-*+]|\d+[.)])\s+(.*)$/;
const BOLD_LABEL = /^\*\*([A-Za-z]+\d+)[.:]/;

function sectionLines(summary: string): { text: string; line: number }[] {
  const lines = summary.split(/\r?\n/);
  const start = lines.findIndex((text) => RECOMMENDATIONS_HEADING.test(text));
  if (start === -1) throw new Error("SUMMARY.md has no Integration recommendations heading");
  const section: { text: string; line: number }[] = [];
  let inFence = false;
  for (let i = start + 1; i < lines.length; i++) {
    const text = lines[i] ?? "";
    if (FENCE.test(text)) inFence = !inFence;
    if (!inFence && SECTION_END.test(text)) break;
    if (!inFence) section.push({ text, line: i + 1 });
  }
  return section;
}

/**
 * Lists the top-level bullets under SUMMARY.md's "Integration recommendations" (or plain
 * "Recommendations") heading, up to the next level-1 or level-2 heading. A bullet led by a bold
 * label such as `**A1.` is that label; any other bullet is `R<n>`, its ordinal in the section.
 * Nested bullets and fenced code are not recommendations. Throws when the heading is missing,
 * so a renamed section cannot pass the gate by having nothing to disposition.
 */
export function summaryRecommendations(summary: string): ReviewItem[] {
  const bullets = sectionLines(summary).flatMap(({ text, line }) => {
    const body = TOP_LEVEL_BULLET.exec(text)?.[1];
    return body === undefined ? [] : [{ body, line }];
  });
  return bullets.map(({ body, line }, index) => ({
    id: BOLD_LABEL.exec(body)?.[1] ?? `R${index + 1}`,
    source: "recommendation",
    line,
  }));
}

/** Lists the P1 and P2 topics of a review's `topics-judged.tsv`, in file order. */
export function prioritizedTopics(topicsTsv: string): ReviewItem[] {
  return readTsv(topicsTsv, ["topic_id", "priority"], "topics-judged.tsv")
    .filter(({ fields }) => fields.priority === "P1" || fields.priority === "P2")
    .map(({ fields, line }) => ({ id: fields.topic_id ?? "", source: "topic", line }));
}
