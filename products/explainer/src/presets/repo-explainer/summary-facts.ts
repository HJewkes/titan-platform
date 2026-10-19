import { readReviewPin } from "@titan-design/pm";
import { parseCites } from "./cite.js";
import type { EvidenceSpan, ExplainerFact, FactKind, FactSource } from "./schemas.js";

/** True when the code at `path` may be shown; gather builds it from the review's `licenses.tsv`. */
type LicenseCheck = (path: string) => boolean;

export interface FactOptions {
  isLicenseSafe?: LicenseCheck;
}

// Headings are matched by prefix: the review process names sections by convention, and the tail drifts.
const SUMMARY_SECTIONS = {
  "what-it-is": "What it is",
  "integration-rec": "Integration recommendations",
  capability: "Capability-to-tier table",
  "should-not": "What we should not do",
  "read-first": "Five files to read first",
  "owner-questions": "Owner",
} as const;
type SummarySection = keyof typeof SUMMARY_SECTIONS;

interface SummaryFacts {
  facts: ExplainerFact[];
  /** Sections whose heading is absent; the caller decides between E-SECTION and W-SECTION. */
  missing: SummarySection[];
}

interface ListItem {
  text: string;
  group?: string;
}

const MIN_SENTENCE = 40;
const ITEM_START = /^(?:[-*]|\d+\.)\s+/;
const BOLD_LEAD = /^\*\*(.+?)\*\*/;
const PATH_TOKEN = /^[\w.@+-]+(?:\/[\w.@+-]+)*$/;
// A bare name needs a short lowercase extension, so a member chain like `rounds.submit` is not a file.
const FILE_NAME = /\.[a-z][a-z0-9]{0,4}$/;
const BARE_RANGE = /^L(\d+)(?:-L?(\d+))?$/;

const pad = (n: number): string => String(n).padStart(2, "0");
const allSafe: LicenseCheck = () => true;

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** A fact is license-safe only when every path it cites is; a fact citing nothing is safe. */
export function licenseSafe(evidence: EvidenceSpan[], check: LicenseCheck = allSafe): boolean {
  return evidence.every((span) => check(span.path));
}

/** Body of each `## ` section keyed by its heading text; a section ends at the next `#` or `##` heading. */
export function splitSections(markdown: string): Map<string, string> {
  const sections = new Map<string, string>();
  let heading: string | undefined;
  let lines: string[] = [];
  const close = () => {
    if (heading !== undefined && !sections.has(heading)) sections.set(heading, lines.join("\n"));
  };
  for (const line of markdown.split("\n")) {
    const match = /^(#{1,2})\s+(.*)$/.exec(line);
    if (match === null) {
      lines.push(line);
      continue;
    }
    close();
    heading = match[1] === "##" ? match[2]!.trim() : undefined;
    lines = [];
  }
  close();
  return sections;
}

/** The first section whose heading starts with `prefix`, ignoring case. */
function findSection(sections: Map<string, string>, prefix: string): string | undefined {
  const wanted = prefix.toLowerCase();
  for (const [heading, body] of sections) {
    if (heading.toLowerCase().startsWith(wanted)) return body;
  }
  return undefined;
}

/** Prose split into sentences of at least 40 characters, newlines folded to spaces; table rows are not prose. */
function sentences(text: string): string[] {
  return text
    .split("\n")
    .filter((line) => !line.trim().startsWith("|"))
    .join("\n")
    .split(/\n\s*\n/)
    .flatMap((paragraph) => paragraph.replace(/\s*\n\s*/g, " ").split(/(?<=[.;])\s+(?=[A-Z*`])/))
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= MIN_SENTENCE);
}

/**
 * Bullet and numbered items with their indented continuation lines folded in. `group` is the most
 * recent bold line outside an item, such as `**Adopt now** (small, MIT)`.
 */
function listItems(body: string): ListItem[] {
  const items: ListItem[] = [];
  let group: string | undefined;
  let open: ListItem | undefined;
  for (const line of body.split("\n")) {
    if (ITEM_START.test(line)) {
      open = { text: line.replace(ITEM_START, "").trim(), ...(group === undefined ? {} : { group }) };
      items.push(open);
    } else if (open !== undefined && /^\s+\S/.test(line)) {
      open.text = `${open.text} ${line.trim()}`;
    } else {
      open = undefined;
      const bold = BOLD_LEAD.exec(line);
      if (bold !== null) group = bold[1]!.trim();
    }
  }
  return items;
}

function looksLikePath(token: string): boolean {
  return PATH_TOKEN.test(token) && (token.includes("/") || FILE_NAME.test(token));
}

/**
 * Citations in `text`, plus a file-level span for each backticked path that no citation bounds. A
 * backticked bare range such as `` `L326-L366` `` binds to the path written before it.
 */
export function codeSpanEvidence(text: string): EvidenceSpan[] {
  const spans: EvidenceSpan[] = parseCites(text);
  let lastPath: string | undefined;
  for (const [, token] of text.matchAll(/`([^`]+)`/g)) {
    const range = BARE_RANGE.exec(token!);
    if (range !== null && lastPath !== undefined) {
      const lineStart = Number(range[1]);
      spans.push({ path: lastPath, lineStart, lineEnd: range[2] === undefined ? lineStart : Number(range[2]) });
    } else {
      lastPath = looksLikePath(token!) ? token! : undefined;
    }
  }
  const bounded = new Set(spans.map((span) => span.path));
  const files = [...text.matchAll(/`([^`]+)`/g)]
    .map(([, token]) => token!)
    .filter((token) => looksLikePath(token) && !bounded.has(token));
  return dedupe([...spans, ...files.map((path) => ({ path }))]);
}

function dedupe(spans: EvidenceSpan[]): EvidenceSpan[] {
  const seen = new Set<string>();
  return spans.filter((span) => {
    const key = `${span.path}:${span.lineStart ?? ""}-${span.lineEnd ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

interface FactDraft {
  id: string;
  kind: FactKind;
  text: string;
  evidence: EvidenceSpan[];
  group?: string;
  verdict?: string;
  tier?: string;
}

function toFact(source: FactSource, draft: FactDraft, options: FactOptions): ExplainerFact {
  const { tier, ...rest } = draft;
  return {
    ...rest,
    source,
    tier: tier ?? source,
    verified: source === "readme" ? "docs" : "yes",
    license_safe: licenseSafe(draft.evidence, options.isLicenseSafe),
  };
}

const summaryFact = (draft: FactDraft, options: FactOptions) => toFact("summary", draft, options);

/** "What it is" sentences, `X-WHAT-NN`. */
export function whatItIsFacts(body: string, options: FactOptions = {}): ExplainerFact[] {
  return sentences(body).map((text, index) =>
    summaryFact({ id: `X-WHAT-${pad(index + 1)}`, kind: "what-it-is", text, evidence: parseCites(text) }, options),
  );
}

/** Integration bullets: `**A1. title**` gives `X-REC-A1`; an unlabelled bullet gives `X-REC-<group>-NN`. */
export function integrationRecFacts(body: string, options: FactOptions = {}): ExplainerFact[] {
  const unlabelled = new Map<string, number>();
  return listItems(body).map(({ text, group }) => {
    const label = /^\*\*([A-Z]\d+)\.\s/.exec(text)?.[1];
    const groupSlug = slug(group ?? "rec");
    const count = (unlabelled.get(groupSlug) ?? 0) + (label === undefined ? 1 : 0);
    unlabelled.set(groupSlug, count);
    const id = label === undefined ? `X-REC-${groupSlug}-${pad(count)}` : `X-REC-${label}`;
    const draft = { id, kind: "integration-rec" as const, text, evidence: codeSpanEvidence(text) };
    return summaryFact(group === undefined ? draft : { ...draft, group }, options);
  });
}

function tableRows(body: string): string[][] {
  return body
    .split("\n")
    .filter((line) => line.trim().startsWith("|"))
    .map((line) =>
      line
        .trim()
        .replace(/^\||\|$/g, "")
        .split("|")
        .map((cell) => cell.trim()),
    )
    .filter((cells) => !cells.every((cell) => /^:?-+:?$/.test(cell)));
}

/** Capability table rows, `X-CAP-<tier-slug>`, carrying the verdict column; no tier column, no facts. */
export function capabilityFacts(body: string, options: FactOptions = {}): ExplainerFact[] {
  const [header, ...rows] = tableRows(body);
  const columns = (header ?? []).map((cell) => cell.toLowerCase());
  const tierAt = columns.indexOf("tier");
  if (tierAt < 0) return [];
  const verdictAt = columns.indexOf("verdict");
  const evidenceAt = columns.indexOf("evidence");
  const whatAt = columns.findIndex((cell) => cell.includes("implementation"));
  const used = new Map<string, number>();
  return rows.map((cells) => {
    const tier = cells[tierAt] ?? "";
    const base = `X-CAP-${slug(tier)}`;
    const seen = (used.get(base) ?? 0) + 1;
    used.set(base, seen);
    const verdict = verdictAt < 0 ? undefined : cells[verdictAt];
    const what = whatAt < 0 ? "" : (cells[whatAt] ?? "");
    const text = [`${tier}: ${what}`, verdict].filter(Boolean).join(". Verdict: ");
    const evidence = evidenceAt < 0 ? [] : codeSpanEvidence(cells[evidenceAt] ?? "");
    const id = seen === 1 ? base : `${base}-${seen}`;
    return summaryFact({ id, kind: "capability", text, evidence, tier, ...(verdict ? { verdict } : {}) }, options);
  });
}

/** "What we should not do" bullets, `X-NOT-NN`. */
export function shouldNotFacts(body: string, options: FactOptions = {}): ExplainerFact[] {
  return listItems(body).map(({ text }, index) =>
    summaryFact({ id: `X-NOT-${pad(index + 1)}`, kind: "should-not", text, evidence: codeSpanEvidence(text) }, options),
  );
}

/** "Five files to read first" items, `X-READ-N`, with the named files as evidence. */
export function readFirstFacts(body: string, options: FactOptions = {}): ExplainerFact[] {
  return listItems(body).map(({ text }, index) =>
    summaryFact({ id: `X-READ-${index + 1}`, kind: "read-first", text, evidence: codeSpanEvidence(text) }, options),
  );
}

/** Owner questions: each `**(a) question**` paragraph, sentence-split, `X-OQ-a-NN`, grouped by the question. */
export function ownerQuestionFacts(body: string, options: FactOptions = {}): ExplainerFact[] {
  const blocks = body.split(/^(?=\*\*\([a-z]\))/m).filter((block) => block.startsWith("**("));
  return blocks.flatMap((block) => {
    const head = /^\*\*\(([a-z])\)\s*(.*?)\*\*/s.exec(block)!;
    const letter = head[1]!;
    const group = head[2]!.replace(/\s+/g, " ").trim();
    return sentences(block.slice(head[0].length)).map((text, index) =>
      summaryFact({ id: `X-OQ-${letter}-${pad(index + 1)}`, kind: "fact", text, evidence: parseCites(text), group }, options),
    );
  });
}

type SectionParser = (body: string, options: FactOptions) => ExplainerFact[];

const SECTION_PARSERS: [SummarySection, SectionParser][] = [
  ["what-it-is", whatItIsFacts],
  ["integration-rec", integrationRecFacts],
  ["capability", capabilityFacts],
  ["should-not", shouldNotFacts],
  ["read-first", readFirstFacts],
  ["owner-questions", ownerQuestionFacts],
];

/** Every tour fact SUMMARY.md yields, and the sections it lacks. */
export function summaryFacts(summary: string, options: FactOptions = {}): SummaryFacts {
  const sections = splitSections(summary);
  const facts: ExplainerFact[] = [];
  const missing: SummarySection[] = [];
  for (const [name, parse] of SECTION_PARSERS) {
    const body = findSection(sections, SUMMARY_SECTIONS[name]);
    if (body === undefined) missing.push(name);
    else facts.push(...parse(body, options));
  }
  return { facts, missing };
}

function entryBlock(readme: string): string | undefined {
  const lines = readme.split("\n");
  const start = lines.findIndex((line) => /^(?:#{2,6}\s+|\*\*)Entry points\b/i.test(line.trim()));
  if (start < 0) return undefined;
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6}\s/.test(line)) break;
    const inList = ITEM_START.test(line) || /^\s+\S/.test(line) || line.trim() === "";
    if (!inList && body.some((kept) => ITEM_START.test(kept))) break;
    body.push(line);
  }
  return body.join("\n");
}

/** README entry-point bullets under `### Entry points` or a `**Entry points**` line, `X-ENTRY-NN`. */
export function entryPointFacts(readme: string, options: FactOptions = {}): ExplainerFact[] {
  const block = entryBlock(readme);
  if (block === undefined) return [];
  return listItems(block).map(({ text }, index) =>
    toFact("readme", { id: `X-ENTRY-${pad(index + 1)}`, kind: "entry-point", text, evidence: codeSpanEvidence(text) }, options),
  );
}

/** The 40-hex commit of the README's `HEAD:` bullet, in any case; anything shorter or longer is no pin. */
export function readPin(readme: string): string | undefined {
  return /^`?([0-9a-f]{40})(?![0-9a-zA-Z])/.exec(readReviewPin(readme).head ?? "")?.[1];
}

/** The coverage line's `unread=N`, from a bullet or a table row; undefined when no line has both. */
export function readCoverage(summary: string): { unread: number; line: string } | undefined {
  for (const line of summary.split("\n")) {
    const unread = /(?<![\w-])unread=(\d+)(?!\w)/.exec(line);
    if (unread !== null && /coverage/i.test(line)) return { unread: Number(unread[1]), line: line.trim() };
  }
  return undefined;
}
