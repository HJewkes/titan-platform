import { describe, expect, it } from "vitest";
import { choppy } from "./rewrite-fixtures.test-helpers.js";
import { visual } from "./resolve-fixtures.test-helpers.js";
import { resolveConfig, ResolvedSchema, runResolveStage } from "./resolve-stage.js";
import { sha256 } from "./workflow/artifacts.js";

const json = (value: unknown): string => JSON.stringify(value);

/** The resolve stage body over an in-memory store holding the named texts as the run's artifacts. */
function stage(texts: Record<string, string>) {
  const bySha = new Map(Object.values(texts).map((text) => [sha256(text), text]));
  const artifacts = Object.fromEntries(Object.entries(texts).map(([name, text]) => [name, sha256(text)]));
  const store = { readText: (sha: string) => bySha.get(sha)!, putText: (text: string) => (bySha.set(sha256(text), text), sha256(text)) };
  const outcome = runResolveStage({ artifacts, store, from: { runId: "r", stage: "resolve" }, remainingUsd: 1 }, resolveConfig());
  return { outcome, store };
}

describe("companion-link cards at resolve", () => {
  const card = { spoken: "The rest lives in the companion doc.", visual: visual({ beat: "companion-link" }) };
  const chapterLinks = (chapters: string[]) =>
    json({ schema: "explainer.chapter-links/v1", doc: "companion.md", docSha: "d".repeat(64), links: chapters.map((chapter) => ({ chapter, section: "health", href: "companion.md#health", facts: [] })) });
  const cardOf = (texts: Record<string, string>) => {
    const { store, outcome } = stage(texts);
    return { outcome, beat: ResolvedSchema.parse(JSON.parse(store.readText(outcome.outputs.resolved!))).beats.find((beat) => beat.id === "c3")! };
  };

  it("fills a card's slots from its chapter's link", () => {
    const { beat } = cardOf({ script: json(choppy({ c3: card })), "chapter-links": chapterLinks(["ch4"]) });

    expect(beat.slots).toEqual({ title: "Health", section: "health", href: "companion.md#health" });
  });

  it("leaves a card unfilled and notes it when the chapter links lack its chapter", () => {
    const { beat, outcome } = cardOf({ script: json(choppy({ c3: card })), "chapter-links": chapterLinks(["ch1"]) });

    expect(beat.slots).toBeUndefined();
    expect(outcome.notes).toContain("no chapter link for companion-link beats c3: the chapter-links artifact lacks their chapters");
  });

  it("leaves a card for template fill in a run with no chapter links", () => {
    const { beat, outcome } = cardOf({ script: json(choppy({ c3: card })) });

    expect(beat.slots).toBeUndefined();
    expect((outcome.notes ?? []).some((note) => note.includes("companion-link"))).toBe(false);
  });
});
