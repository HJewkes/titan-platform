import { PlaybookStore, memoryMigration } from "@titan-design/memory";
import { openDatabase, runMigrations, type Db } from "@titan-design/store-sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writePrincipleDocs } from "./docs.js";
import { principleBullet, type Principle } from "./principles.js";
import { changesByDomain, parsePriorDoc, quoteOf, renderDomainDoc, type DomainChanges } from "./render.js";

const NOW = new Date("2026-03-01T12:00:00Z");
const NONE: DomainChanges = { added: [], promoted: [], demoted: [], retired: [], confirmed: [], contradicted: [] };

function principle(overrides: Partial<Principle> = {}): Principle {
  return {
    id: "b-1",
    domain: "tech_design",
    rule: "Prefer a queue over cron for refresh jobs",
    isNegative: false,
    maturity: "established",
    score: 2.5,
    lastConfirmed: "2026-02-20T00:00:00Z",
    examples: ["queue:1", "queue:2"],
    counterExamples: ["queue:9"],
    ...overrides,
  };
}

describe("renderDomainDoc", () => {
  it("writes rule, confidence, last confirmed, quoted examples and counter-examples", () => {
    const quotes: Record<string, string> = { "queue:1": "Use the queue" };

    const { markdown } = renderDomainDoc(
      { domain: "tech_design", principles: [principle()], changes: { ...NONE, added: ["b-1"] }, prior: null, now: NOW },
      { quote: (key) => quotes[key] },
    );

    expect(markdown).toContain("domain: tech_design\nversion: 1\n");
    expect(markdown).toContain("Rule: Prefer a queue over cron for refresh jobs");
    expect(markdown).toContain("- Confidence: established, score 2.50");
    expect(markdown).toContain("- Last confirmed: 2026-02-20");
    expect(markdown).toContain('- Examples:\n  - `queue:1`: "Use the queue"\n  - `queue:2`\n');
    expect(markdown).toContain("- Counter-examples:\n  - `queue:9`\n");
    expect(markdown).toContain("## Changelog\n\n- v1 (2026-03-01): added b-1\n");
  });

  it("orders principles by maturity then score and caps examples at the newest few", () => {
    const { markdown } = renderDomainDoc(
      {
        domain: "tech_design",
        principles: [
          principle({ id: "b-low", maturity: "candidate", score: 9 }),
          principle({ id: "b-proven", maturity: "proven", score: 1, examples: ["k1", "k2", "k3"], counterExamples: [] }),
        ],
        changes: NONE,
        prior: null,
        now: NOW,
      },
      { maxExamples: 2 },
    );

    expect(markdown.indexOf("## b-proven")).toBeLessThan(markdown.indexOf("## b-low"));
    expect(markdown).toContain("- Examples:\n  - `k2`\n  - `k3`\n- Counter-examples:\n  - none\n");
    expect(markdown).toContain("- v1 (2026-03-01): first render");
  });

  it("bumps the version and prepends a changelog line only when the domain changed", () => {
    const first = renderDomainDoc({ domain: "agent_ops", principles: [principle()], changes: NONE, prior: null, now: NOW });
    const quiet = renderDomainDoc({ domain: "agent_ops", principles: [principle()], changes: NONE, prior: parsePriorDoc(first.markdown), now: NOW });
    const changed = renderDomainDoc({
      domain: "agent_ops",
      principles: [],
      changes: { ...NONE, demoted: ["b-1"], retired: ["b-2"], contradicted: ["b-1"] },
      prior: parsePriorDoc(quiet.markdown),
      now: NOW,
    });

    expect(quiet).toMatchObject({ version: 1, bumped: false });
    expect(changed).toMatchObject({ version: 2, bumped: true });
    expect(changed.markdown).toContain("No live principles.");
    expect(parsePriorDoc(changed.markdown)?.changelog).toEqual([
      "- v2 (2026-03-01): demoted b-1; retired b-2; contradicted b-1",
      "- v1 (2026-03-01): first render",
    ]);
  });

  it("labels an anti-pattern principle as one to avoid", () => {
    const { markdown } = renderDomainDoc({ domain: "agent_ops", principles: [principle({ isNegative: true, rule: "Asking twice" })], changes: NONE, prior: null, now: NOW });

    expect(markdown).toContain("Avoid: Asking twice");
  });
});

describe("quoteOf", () => {
  it("takes the first non-blank line of the answer, else the question, and truncates", () => {
    expect(quoteOf({ answer: "\n  Use the queue  \nbecause retries", question: "Q" })).toBe("Use the queue");
    expect(quoteOf({ answer: null, question: "Which scheduler?" })).toBe("Which scheduler?");
    expect(quoteOf({ answer: "x".repeat(50), question: "Q" }, 10)).toBe("xxxxxxx...");
  });
});

describe("writePrincipleDocs and changesByDomain", () => {
  let db: Db;
  let store: PlaybookStore;
  let dir: string;

  beforeEach(() => {
    db = openDatabase(":memory:");
    runMigrations(db, [memoryMigration(1)]);
    store = new PlaybookStore(db, { now: () => NOW });
    dir = join(mkdtempSync(join(tmpdir(), "decider-principles-")), "principles");
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("groups a run's changes by principle domain, retired principles included", () => {
    const a = store.add(principleBullet({ rule: "A", domain: "agent_ops", citedKeys: [] }));
    const b = store.add(principleBullet({ rule: "B", domain: "tech_design", citedKeys: [] }));
    store.deprecate(b.id, "contradicted");

    const changes = changesByDomain(store, {
      added: [a.id],
      maturityChanges: [{ bulletId: a.id, from: "candidate", to: "established" }, { bulletId: b.id, from: "candidate", to: "deprecated" }],
      feedback: [{ principleId: a.id, type: "helpful", sessionRef: "ledger:queue:1", at: undefined, reason: null }],
      retired: ["unknown"],
    });

    expect(changes.get("agent_ops")).toEqual({ ...NONE, added: [a.id], promoted: [a.id], confirmed: [a.id] });
    expect(changes.get("tech_design")).toEqual({ ...NONE, retired: [b.id] });
  });

  it("writes one markdown file per domain and keeps the changelog across runs", () => {
    const principles = new Map([["tech_design", [principle()]], ["agent_ops", [principle({ id: "b-2", domain: "agent_ops" })]]]);

    const first = writePrincipleDocs({ dir, principles, changes: new Map(), now: NOW });
    const second = writePrincipleDocs({ dir, principles, changes: new Map([["tech_design", { ...NONE, confirmed: ["b-1"] }]]), now: new Date("2026-03-02T00:00:00Z") });

    expect(first.map((d) => [d.domain, d.version])).toEqual([["agent_ops", 1], ["tech_design", 1]]);
    expect(second.map((d) => [d.domain, d.version, d.bumped])).toEqual([["agent_ops", 1, false], ["tech_design", 2, true]]);
    expect(readFileSync(join(dir, "tech_design.md"), "utf8")).toContain("- v2 (2026-03-02): confirmed b-1\n- v1 (2026-03-01): first render\n");
  });

  it("refuses a domain that would escape the principles directory", () => {
    expect(() => writePrincipleDocs({ dir, principles: new Map([["../x", [principle()]]]), changes: new Map(), now: NOW })).toThrow(/invalid principle domain/);
  });
});
