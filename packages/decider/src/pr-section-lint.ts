/**
 * The owner PR section contract as a pure lint, in the shape of `lintAsk`. A section about one PR
 * carries the PR URL (PR1), says what the PR does in at least two sentences (PR2), says why it
 * reaches the owner with a gate class and a rule id (PR3), lists a pro and a con (PR4), and for a
 * UI PR pairs a before and an after image per changed story or says why there are none (PR5).
 */
import type { AskFinding } from "./ask-lint.js";

export const PR_SECTION_RULES = ["PR1", "PR2", "PR3", "PR4", "PR5"] as const;
export type PrSectionRule = (typeof PR_SECTION_RULES)[number];
export type PrSectionFinding = AskFinding<PrSectionRule>;

interface Part {
  heading: string;
  lines: string[];
}

const PR_URL = /\bhttps:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+\b/;
const HEADING = /^#{1,6}\s+(.*)$/;
const BULLET = /^\s*[-*]\s+\S/;
const BACKTICK_SPAN = /`[^`]*`/g;
const URL = /\bhttps?:\/\/\S+/g;
const IMAGE = /!\[[^\]]*\]\([^)\s]+\)/g;
const HAS_IMAGE = new RegExp(IMAGE.source);
/** An upper-case policy id (`MRG-AU-RV`) or a `table/row` pair (`shepherd-merge-guard/github-path`). */
const RULE_ID = /^(?:[A-Z]{2,}(?:-[A-Z][A-Z0-9]*)+|[a-z][\w-]*(?:\/[\w-]+)+|shepherd-[a-z-]+)$/;
const GATE_CLASS = /\b(?:deliberate|accidental|gate 2|hard stop|npm publish|security[- ]posture)\b/i;
const UI_SIGNAL = /!\[|\bstor(?:y|ies)\b|\bstorybook\b|\bgate 2\b/i;
const TABLE_SEPARATOR = /^\|[\s:|-]+\|$/;
const MIN_SENTENCES = 2;
const MIN_SENTENCE_WORDS = 3;
const MIN_REASON_WORDS = 3;

const PART_NAMES = {
  what: { label: "What it does", heading: /^what it does\b/i },
  why: { label: "Why it reaches you", heading: /^why\b/i },
  pros: { label: "Pros", heading: /^pros\b/i },
  cons: { label: "Cons", heading: /^cons\b/i },
  visuals: { label: "Before and after", heading: /^before and after\b/i },
} as const;
type PartName = keyof typeof PART_NAMES;

/** Every heading opens a part; a part runs to the next heading of any level. */
function splitParts(section: string): Part[] {
  const parts: Part[] = [];
  for (const line of section.split("\n")) {
    const heading = HEADING.exec(line);
    if (heading) parts.push({ heading: (heading[1] ?? "").replace(/\*\*/g, "").trim(), lines: [] });
    else parts.at(-1)?.lines.push(line);
  }
  return parts;
}

function partText(parts: readonly Part[], name: PartName): string | null {
  const part = parts.find((p) => PART_NAMES[name].heading.test(p.heading));
  return part ? part.lines.join("\n").trim() : null;
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter((w) => /\p{L}/u.test(w)).length;
}

function sentenceCount(text: string): number {
  const prose = text.split("\n").filter((line) => !BULLET.test(line)).join(" ");
  const plain = prose.replace(BACKTICK_SPAN, " code ").replace(URL, " link ");
  return plain.split(/(?<=[.?!])\s+/).filter((s) => /[.?!]$/.test(s.trim()) && wordCount(s) >= MIN_SENTENCE_WORDS).length;
}

function missing(name: PartName): string {
  return `no ${PART_NAMES[name].label} section`;
}

function describeTriggers(text: string | null): string[] {
  if (text === null) return [missing("what")];
  const sentences = sentenceCount(text);
  return sentences >= MIN_SENTENCES ? [] : [`${PART_NAMES.what.label} has ${sentences} sentence(s), needs ${MIN_SENTENCES}`];
}

function whyTriggers(text: string | null): string[] {
  if (text === null) return [missing("why")];
  const triggers: string[] = [];
  if (!GATE_CLASS.test(text)) triggers.push("names no gate class (deliberate, accidental, Gate 2, hard stop, npm publish, security posture)");
  const spans = (text.match(BACKTICK_SPAN) ?? []).map((span) => span.slice(1, -1).trim());
  if (!spans.some((span) => RULE_ID.test(span))) triggers.push("names no rule id in backticks");
  return triggers;
}

function listTriggers(parts: readonly Part[], name: "pros" | "cons"): string[] {
  const text = partText(parts, name);
  if (text === null) return [missing(name)];
  return text === "" ? [`${PART_NAMES[name].label} section is empty`] : [];
}

function tableRows(text: string): string[][] {
  const lines = text.split("\n").map((line) => line.trim()).filter((line) => line.startsWith("|"));
  const separator = lines.findIndex((line) => TABLE_SEPARATOR.test(line));
  return lines.slice(separator + 1).map((line) => line.replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim()));
}

/** A cell holds its image, or says in words why it has none. */
function cellCovered(cell: string | undefined): boolean {
  if (!cell) return false;
  return HAS_IMAGE.test(cell) || wordCount(cell) >= 2;
}

function storyRowTriggers(rows: readonly string[][]): string[] {
  return rows
    .filter(([, before, after]) => !cellCovered(before) || !cellCovered(after))
    .map(([story]) => `story ${story ?? "?"} lacks a before and after image pair`);
}

function visualTriggers(section: string, text: string | null): string[] {
  if (text === null) return UI_SIGNAL.test(section) ? [`UI PR with ${missing("visuals")}`] : [];
  const rows = tableRows(text);
  if (rows.length > 0) return storyRowTriggers(rows);
  const images = (text.match(IMAGE) ?? []).length;
  if (images >= 2 || (images === 0 && wordCount(text) >= MIN_REASON_WORDS)) return [];
  return [`${PART_NAMES.visuals.label} has ${images} image(s) and no stated reason`];
}

function finding(rule: PrSectionRule, triggers: readonly string[]): PrSectionFinding[] {
  return triggers.length > 0 ? [{ rule, evidence: triggers.join("; ") }] : [];
}

/** Every contract rule an owner PR section breaks, in rule order; an empty list means it passes. */
export function lintPrSection(section: string): PrSectionFinding[] {
  const parts = splitParts(section);
  return [
    ...finding("PR1", PR_URL.test(section) ? [] : ["no GitHub pull request URL"]),
    ...finding("PR2", describeTriggers(partText(parts, "what"))),
    ...finding("PR3", whyTriggers(partText(parts, "why"))),
    ...finding("PR4", [...listTriggers(parts, "pros"), ...listTriggers(parts, "cons")]),
    ...finding("PR5", visualTriggers(section, partText(parts, "visuals"))),
  ];
}
