import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { loadProfiles, profileFor } from "../../profile-load.js";
import { COMPANION_FILE, COMPANION_SECTIONS, companionChapters, companionLinkSlots, factAnchor, renderCompanion, reviewFacts, type ChapterLinks, type ChapterSource, type CompanionResult } from "./companion.js";
import { gatherReview } from "./gather.js";
import { FACT_KINDS, type ExplainerFact } from "./schemas.js";

const FIXTURE = fileURLToPath(new URL("../../../fixtures/review-whiteboard", import.meta.url));
const PIN = "2ddf3eb6c13d97b1d04a932c21de9a92029adaf9";
const TOUR_BLOCKS = COMPANION_SECTIONS.map((section) => section.id);

let facts: ExplainerFact[];

beforeAll(async () => {
  const result = await gatherReview({ reviewDir: FIXTURE, clonePath: "/clone/whiteboard", readHead: async () => PIN });
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  facts = result.facts;
});

const firstOf = (kind: ExplainerFact["kind"]): string => facts.find((fact) => fact.kind === kind)!.id;

/** A spine as `pickSpine` writes one: journey row n plays block `steps[n-1]`, chapter rows name the journey rows they play. */
function spineOf(steps: string[], chapters: [string, number[]][]) {
  return {
    journey: steps.map((step, i) => ({ n: i + 1, step, what: step, why: "—", invariant: null, breaksToday: null })),
    chapters: chapters.map(([chapter, rows]) => ({ chapter, question: `${chapter}?`, rows: rows.map((n) => `§3.${n}`) })),
  };
}

function scriptOf(cites: Record<string, string[]>): ChapterSource {
  const ids = Object.keys(cites);
  return { chapters: ids.map((id) => ({ id })), beats: ids.map((id) => ({ chapter: id, fact_ids: cites[id]! })) };
}

/** The 8-12 min tour: one chapter per block, in the fixed order. */
function tour(): CompanionResult {
  const chapters = TOUR_BLOCKS.map((_, i): [string, number[]] => [`ch${i + 1}`, [i + 1]]);
  const cites = Object.fromEntries(chapters.map(([id]) => [id, [] as string[]]));
  cites.ch6 = [firstOf("feature")];
  cites.ch10 = [firstOf("read-first")];
  return renderCompanion(facts, companionChapters(scriptOf(cites), spineOf(TOUR_BLOCKS, chapters)));
}

/** The 2-3 min digest cut: its middle chapter merges purpose and architecture. */
function digest(): CompanionResult {
  const spine = spineOf(["cold-open", "purpose", "architecture", "scorecard"], [["d1", [1]], ["d2", [2, 3]], ["d3", [4]]]);
  const script = scriptOf({ d1: [firstOf("what-it-is")], d2: [], d3: [firstOf("integration-rec")] });
  return renderCompanion(facts, companionChapters(script, spine));
}

const anchors = (markdown: string): Set<string> => new Set([...markdown.matchAll(/<a id="([^"]+)"><\/a>/g)].map((match) => match[1]!));

/** The doc's text from a section's anchor up to the next section's. */
function sectionText(markdown: string, section: string): string {
  const start = markdown.indexOf(`<a id="${section}"></a>`);
  const next = TOUR_BLOCKS.map((id) => markdown.indexOf(`<a id="${id}"></a>`)).filter((at) => at > start).sort((a, b) => a - b)[0];
  return markdown.slice(start, next ?? markdown.length);
}

describe("the repo companion doc over the whiteboard review", () => {
  it("gives every tour and digest chapter a link whose anchor the doc holds", () => {
    const results = [tour(), digest()];

    for (const { markdown, links } of results) {
      const held = anchors(markdown);
      for (const link of links) {
        expect(link.href.startsWith(`${COMPANION_FILE}#`), link.chapter).toBe(true);
        expect(held.has(link.href.split("#")[1]!), link.href).toBe(true);
      }
    }
    expect(results.map((result) => result.links.length)).toEqual([TOUR_BLOCKS.length, 3]);
  });

  it("links the tour and the digest into the same doc, a merged digest chapter at its first tour chapter's anchor", () => {
    const tourDoc = tour();
    const digestDoc = digest();

    expect(digestDoc.markdown).toBe(tourDoc.markdown);
    const tourHref = (chapter: string) => tourDoc.links.find((link) => link.chapter === chapter)!.href;
    expect(digestDoc.links.map((link) => link.href)).toEqual([tourHref("ch1"), tourHref("ch2"), tourHref("ch9")]);
  });

  it("places each fact a chapter cites in that chapter's section, at the fact's own anchor", () => {
    const { markdown, links } = tour();

    const cited = links.flatMap((link) => link.facts.map((fact) => ({ section: link.section, ...fact })));
    expect(cited.map((fact) => fact.section)).toEqual(["features", "read-first"]);
    for (const fact of cited) {
      expect(fact.href).toBe(`${COMPANION_FILE}#${factAnchor(fact.id)}`);
      expect(sectionText(markdown, fact.section)).toContain(`<a id="${factAnchor(fact.id)}"></a>**${fact.id}**`);
    }
  });

  it("puts every gathered fact in the doc once", () => {
    const { markdown } = tour();

    for (const fact of facts) expect(markdown.split(`<a id="${factAnchor(fact.id)}"></a>`).length - 1, fact.id).toBe(1);
  });

  it("warns W-NO-SUMMARY, and still renders every section, when no fact comes from the SUMMARY", () => {
    const withoutSummary = facts.filter((fact) => fact.source !== "summary");

    const result = renderCompanion(withoutSummary, [{ id: "ch1", blocks: ["cold-open"], factIds: [] }]);

    expect(result.diagnostics.map((d) => [d.code, d.severity])).toEqual([["W-NO-SUMMARY", "warning"]]);
    for (const block of TOUR_BLOCKS) expect(anchors(result.markdown).has(block)).toBe(true);
    expect(result.links[0]!.href).toBe(`${COMPANION_FILE}#cold-open`);
  });

  it("links a chapter that plays no tour block to the contents, and drops a cited fact the review lacks, with warnings", () => {
    const result = renderCompanion(facts, [{ id: "ch1", blocks: ["scan"], factIds: ["NOPE-1"] }]);

    expect(result.diagnostics.map((d) => d.code)).toEqual(["W-CHAPTER-UNMAPPED", "W-FACT-UNKNOWN"]);
    expect(result.links).toEqual([{ chapter: "ch1", section: "contents", href: `${COMPANION_FILE}#contents`, facts: [] }]);
    expect(anchors(result.markdown).has("contents")).toBe(true);
  });

  it("gives a chapter's companion-link card its section's title, or the contents' for an unmapped chapter", () => {
    const result = renderCompanion(facts, [{ id: "ch1", blocks: ["health"], factIds: [] }, { id: "ch2", blocks: ["scan"], factIds: [] }]);
    const links: ChapterLinks = { schema: "explainer.chapter-links/v1", doc: COMPANION_FILE, docSha: "d".repeat(64), links: result.links };

    const slots = ["ch1", "ch2", "ch3"].map((chapter) => companionLinkSlots(links, chapter));

    expect(slots).toEqual([
      { title: "Health", section: "health", href: `${COMPANION_FILE}#health` },
      { title: "Contents", section: "contents", href: `${COMPANION_FILE}#contents` },
      undefined,
    ]);
  });
});

describe("companion sections", () => {
  it("are the repo-tour profile's blocks, in its order, and cover every fact kind exactly once", () => {
    const blocks = profileFor(loadProfiles(), "repo-tour").structure.blocks.map((block) => block.id);

    expect(TOUR_BLOCKS).toEqual(blocks);
    expect(COMPANION_SECTIONS.flatMap((section) => section.kinds).sort()).toEqual([...FACT_KINDS].sort());
  });
});

describe("companion chapters", () => {
  it("plays block n in chapter n when the spine has no chapter rows", () => {
    const chapters = companionChapters(scriptOf({ a: ["F1", "F1"], b: [] }), spineOf(["purpose", "health"], []));

    expect(chapters).toEqual([{ id: "a", blocks: ["purpose"], factIds: ["F1"] }, { id: "b", blocks: ["health"], factIds: [] }]);
  });
});

describe("reviewFacts", () => {
  it("reads gathered facts.jsonl and refuses a facts table or a line that is not a review fact", () => {
    const jsonl = facts.slice(0, 3).map((fact) => JSON.stringify(fact)).join("\n");

    expect(reviewFacts(`${jsonl}\n`)?.map((fact) => fact.id)).toEqual(facts.slice(0, 3).map((fact) => fact.id));
    expect(reviewFacts("| Id | Claim |\n|---|---|\n| F1 | x |\n")).toBeUndefined();
    expect(reviewFacts(`${jsonl}\n${JSON.stringify({ id: "c1", kind: "change", text: "x" })}\n`)).toBeUndefined();
  });
});
