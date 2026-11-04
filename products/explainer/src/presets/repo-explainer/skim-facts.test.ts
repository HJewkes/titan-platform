import { describe, expect, it } from "vitest";
import { ExplainerFactSchema } from "./schemas.js";
import { skimFacts } from "./skim-facts.js";

const skim = (facts: unknown[]) => JSON.stringify({ head: "2ddf3eb6", ok: true, facts });
const fact = (kind: string, source = "README.md") => ({ kind, text: `A ${kind} fact.`, quote: `the ${kind} quote`, source });

describe("skimFacts", () => {
  it("maps each skim kind onto an explainer kind and numbers facts per skim kind", () => {
    const kinds = ["purpose", "pain", "pain", "actor", "job", "entry_command", "non_goal"];

    const { facts, diagnostics } = skimFacts(skim(kinds.map((kind) => fact(kind))));

    expect(diagnostics).toEqual([]);
    expect(facts.map((entry) => [entry.id, entry.kind])).toEqual([
      ["skim/purpose/1", "what-it-is"],
      ["skim/pain/1", "pain"],
      ["skim/pain/2", "pain"],
      ["skim/actor/1", "actor"],
      ["skim/job/1", "job"],
      ["skim/entry_command/1", "entry-point"],
      ["skim/non_goal/1", "should-not"],
    ]);
  });

  it("cites the source file as docs evidence with the quote as a caption", () => {
    const [only] = skimFacts(skim([fact("purpose")])).facts;

    expect(ExplainerFactSchema.parse(only)).toMatchObject({
      source: "skim",
      text: "A purpose fact.",
      evidence: [{ path: "README.md" }],
      verified: "docs",
      captions: ["the purpose quote"],
      license_safe: true,
    });
  });

  it("marks a fact from an unlicensed source as not license-safe", () => {
    const options = { isLicenseSafe: (path: string) => !path.startsWith("vendor/") };

    const { facts } = skimFacts(skim([fact("job", "vendor/README.md"), fact("job")]), options);

    expect(facts.map((entry) => entry.license_safe)).toEqual([false, true]);
  });

  it("skips an unknown kind with W-BAD-ROW and keeps the rest", () => {
    const { facts, diagnostics } = skimFacts(skim([fact("slogan"), fact("purpose")]));

    expect(facts.map((entry) => entry.id)).toEqual(["skim/purpose/1"]);
    expect(diagnostics).toEqual([expect.objectContaining({ code: "W-BAD-ROW", selector: "explainer-skim.json#facts/0" })]);
  });

  it("returns a W-BAD-ROW diagnostic instead of throwing on malformed JSON", () => {
    const { facts, diagnostics } = skimFacts("{not json");

    expect(facts).toEqual([]);
    expect(diagnostics.map((finding) => finding.code)).toEqual(["W-BAD-ROW"]);
  });
});
