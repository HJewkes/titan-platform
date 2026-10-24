import { z } from "zod";
import type { ScriptBeat, ScriptChapter } from "../../script-schema.js";
import type { SpineV1 } from "../../spine-schema.js";
import { diag, type GatherDiagnostic } from "./diagnostics.js";
import { ExplainerFactSchema, type ExplainerFact, type FactKind } from "./schemas.js";

/** The companion doc's name in a run; the tour and every cut of it link into this one file. */
export const COMPANION_FILE = "companion.md";
const CONTENTS_ANCHOR = "contents";
const CONTENTS_TITLE = "Contents";

export interface CompanionSection {
  id: string;
  title: string;
  kinds: readonly FactKind[];
}

/**
 * The martini glass's bowl: one section per repo-tour block, in the tour's fixed chapter order (VT §2.2). The anchor
 * is the block id, so a chapter's link survives any cut that keeps the block. Together the kinds cover every fact kind,
 * so no gathered fact falls out of the doc.
 */
export const COMPANION_SECTIONS: readonly CompanionSection[] = [
  { id: "cold-open", title: "Verdict", kinds: ["what-it-is", "pain"] },
  { id: "purpose", title: "Purpose", kinds: ["actor", "job", "capability"] },
  { id: "entry-points", title: "Entry points", kinds: ["entry-point"] },
  { id: "architecture", title: "Architecture", kinds: ["shape"] },
  { id: "request-walk", title: "Request walk", kinds: [] },
  { id: "features", title: "Features", kinds: ["feature"] },
  { id: "worth-knowing", title: "Worth knowing", kinds: ["gotcha", "claim", "fact"] },
  { id: "health", title: "Health", kinds: ["hotspot", "silo", "guard"] },
  { id: "scorecard", title: "Scorecard", kinds: ["integration-rec", "should-not"] },
  { id: "read-first", title: "Read first", kinds: ["read-first"] },
];

/** A video chapter as the companion sees it: the profile blocks it plays, in order, and the facts its beats cite. */
export interface CompanionChapter {
  id: string;
  blocks: readonly string[];
  factIds: readonly string[];
}

const FactLinkSchema = z.object({ id: z.string(), href: z.string() });
export type FactLink = z.infer<typeof FactLinkSchema>;

/** Where a chapter's card points: its section, and each fact it cites at that fact's own anchor. */
const ChapterLinkSchema = z.object({ chapter: z.string(), section: z.string(), href: z.string(), facts: z.array(FactLinkSchema) });
export type ChapterLink = z.infer<typeof ChapterLinkSchema>;

/** The run's `chapter-links` artifact: the companion doc by name and content hash, and every chapter's link into it. */
export const ChapterLinksSchema = z.object({
  schema: z.literal("explainer.chapter-links/v1"),
  doc: z.literal(COMPANION_FILE),
  docSha: z.string(),
  links: z.array(ChapterLinkSchema),
});
export type ChapterLinks = z.infer<typeof ChapterLinksSchema>;

/** The `companion-link` beat's slots: the card names the section it opens and links straight to it. */
export interface CompanionLinkSlots {
  title: string;
  section: string;
  href: string;
}

/** A chapter's `companion-link` slots from the run's chapter links, or undefined when the links hold no such chapter. */
export function companionLinkSlots(links: ChapterLinks, chapter: string): CompanionLinkSlots | undefined {
  const link = links.links.find((entry) => entry.chapter === chapter);
  if (link === undefined) return undefined;
  const title = COMPANION_SECTIONS.find((section) => section.id === link.section)?.title ?? CONTENTS_TITLE;
  return { title, section: link.section, href: link.href };
}

export interface CompanionResult {
  markdown: string;
  links: ChapterLink[];
  diagnostics: GatherDiagnostic[];
}

export const factAnchor = (id: string): string => `fact-${id.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;

const href = (anchor: string): string => `${COMPANION_FILE}#${anchor}`;
const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

function sectionOf(kind: FactKind): CompanionSection {
  return COMPANION_SECTIONS.find((section) => section.kinds.includes(kind))!;
}

function spanText(fact: ExplainerFact): string {
  const spans = fact.evidence.map((span) => (span.lineStart === undefined ? span.path : `${span.path}:L${span.lineStart}-L${span.lineEnd}`));
  return spans.length === 0 ? "" : ` (${spans.map((span) => `\`${span}\``).join(", ")})`;
}

function factLine(fact: ExplainerFact): string {
  return `- <a id="${factAnchor(fact.id)}"></a>**${fact.id}** ${oneLine(fact.text)}${spanText(fact)} [${fact.source}, verified ${fact.verified}]`;
}

function sectionBlock(section: CompanionSection, facts: readonly ExplainerFact[]): string {
  const body = facts.length === 0 ? "_The review holds no facts for this section._" : facts.map(factLine).join("\n");
  return `<a id="${section.id}"></a>\n\n## ${section.title}\n\n${body}`;
}

function contents(bySection: ReadonlyMap<string, ExplainerFact[]>, hasSummary: boolean): string {
  const rows = COMPANION_SECTIONS.map((section) => `- [${section.title}](#${section.id}): ${bySection.get(section.id)!.length} facts`);
  const absent = hasSummary ? [] : ["", "_The review SUMMARY gave no facts; the sections below hold only the other review files' facts._"];
  return [`<a id="${CONTENTS_ANCHOR}"></a>`, "", `## ${CONTENTS_TITLE}`, "", ...rows, ...absent].join("\n");
}

function renderDoc(facts: readonly ExplainerFact[]): string {
  const bySection = new Map(COMPANION_SECTIONS.map((section) => [section.id, [] as ExplainerFact[]]));
  for (const fact of facts) bySection.get(sectionOf(fact.kind).id)!.push(fact);
  const lead = "The reference the video only points at: every review fact, grouped by the tour chapter that opens it.";
  const sections = COMPANION_SECTIONS.map((section) => sectionBlock(section, bySection.get(section.id)!));
  return `${["# Companion doc", lead, contents(bySection, facts.some((fact) => fact.source === "summary")), ...sections].join("\n\n")}\n`;
}

// A chapter that merges tour blocks links the first one the doc has a section for.
function chapterLink(chapter: CompanionChapter, known: ReadonlySet<string>, out: GatherDiagnostic[]): ChapterLink {
  const section = chapter.blocks.find((block) => COMPANION_SECTIONS.some((s) => s.id === block));
  if (section === undefined) out.push(diag("W-CHAPTER-UNMAPPED", `chapter ${chapter.id} plays no tour block (${chapter.blocks.join(", ") || "none"}); it links the contents`, chapter.id));
  const facts = chapter.factIds.flatMap((id) => {
    if (known.has(id)) return [{ id, href: href(factAnchor(id)) }];
    out.push(diag("W-FACT-UNKNOWN", `chapter ${chapter.id} cites ${id}, which the gathered facts lack`, id));
    return [];
  });
  const anchor = section ?? CONTENTS_ANCHOR;
  return { chapter: chapter.id, section: anchor, href: href(anchor), facts };
}

/**
 * The repo companion doc (profiles plan §B.3): the bowl the video's chapters point into, rendered from the gathered
 * facts alone, so the tour and its digest cut over the same review link the same bytes. Each chapter gets its
 * section's anchor and an anchor per fact it cites.
 */
export function renderCompanion(facts: readonly ExplainerFact[], chapters: readonly CompanionChapter[]): CompanionResult {
  const diagnostics: GatherDiagnostic[] = [];
  if (!facts.some((fact) => fact.source === "summary")) diagnostics.push(diag("W-NO-SUMMARY", "no fact comes from the review SUMMARY; the companion doc holds only the other files' facts", "SUMMARY.md"));
  const known = new Set(facts.map((fact) => fact.id));
  const links = chapters.map((chapter) => chapterLink(chapter, known, diagnostics));
  return { markdown: renderDoc(facts), links, diagnostics };
}

const JOURNEY_REF = /^§3\.(\d+)$/;

function spineBlocks(spine: Pick<SpineV1, "journey" | "chapters">, chapter: string, position: number): string[] {
  const row = spine.chapters.find((entry) => entry.chapter === chapter);
  const numbers = row === undefined ? [position + 1] : row.rows.flatMap((ref) => {
    const n = JOURNEY_REF.exec(ref)?.[1];
    return n === undefined ? [] : [Number(n)];
  });
  return numbers.flatMap((n) => spine.journey.filter((step) => step.n === n).map((step) => step.step));
}

/** The parts of a script/v1 the chapter links read. */
export interface ChapterSource {
  chapters: readonly Pick<ScriptChapter, "id">[];
  beats: readonly Pick<ScriptBeat, "chapter" | "fact_ids">[];
}

/**
 * Each script chapter's blocks and cited facts. A chapter's §8 row names the journey rows it plays (`§3.n`), and each
 * journey row's step is a profile block, as `pickSpine` writes them; a spine with no §8 row plays block n in chapter n.
 */
export function companionChapters(script: ChapterSource, spine: Pick<SpineV1, "journey" | "chapters">): CompanionChapter[] {
  return script.chapters.map((chapter, i) => {
    const cited = script.beats.filter((beat) => beat.chapter === chapter.id).flatMap((beat) => beat.fact_ids);
    return { id: chapter.id, blocks: spineBlocks(spine, chapter.id, i), factIds: [...new Set(cited)] };
  });
}

/** The facts artifact as review facts, or undefined when it is not `facts.jsonl` of gathered `ExplainerFact`s. */
export function reviewFacts(text: string): ExplainerFact[] | undefined {
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  const facts: ExplainerFact[] = [];
  for (const line of lines) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return undefined;
    }
    const parsed = ExplainerFactSchema.safeParse(value);
    if (!parsed.success) return undefined;
    facts.push(parsed.data);
  }
  return facts.length === 0 ? undefined : facts;
}
