import { describe, expect, it } from "vitest";
import { classifyPr, DEFAULT_CLASS_RULES } from "./classify.js";
import type { ChangedFile, PrFacts } from "./types.js";

const file = (path: string, additions = 5, deletions = 1): ChangedFile => ({ path, additions, deletions });
const facts = (paths: string[], extra: Partial<PrFacts> = {}): PrFacts =>
  ({ repo: "o/r", number: 1, head: "h", base: "b", kind: "feature", changedFiles: paths.map((p) => file(p)), ...extra }) as PrFacts;

describe("classifyPr", () => {
  it("treats CODEOWNERS and workflow edits as authority", () => {
    for (const path of [".github/CODEOWNERS", ".github/workflows/ci.yml"]) {
      const result = classifyPr(facts([path]));
      expect(result.class).toBe("g10");
      expect(result.touches).toEqual(["authority"]);
    }
  });

  it("treats a required-checks policy file as authority and policy", () => {
    const result = classifyPr(facts(["packages/authority/src/required-checks-policy.ts", "products/factory/src/shepherd/gate-policy.ts"]));
    expect(result.class).toBe("g10");
    expect(result.touches).toEqual(expect.arrayContaining(["authority", "policy"]));
  });

  it("treats a gate schema file as policy", () => {
    const result = classifyPr(facts(["packages/gates/src/gate-schema.json"]));
    expect(result.class).toBe("g10");
    expect(result.touches).toEqual(["policy"]);
  });

  it("keeps a ui-only change standard with the visual flag", () => {
    const result = classifyPr(facts(["packages/react-app/src/Button.test.tsx", "packages/react-app/src/Button.css"]));
    expect(result).toEqual({ class: "standard", touches: ["visual"] });
  });

  it("flags a source change with no test change as untested", () => {
    expect(classifyPr(facts(["packages/x/src/a.ts"])).touches).toEqual(["untested"]);
    expect(classifyPr(facts(["packages/x/src/a.ts", "packages/x/src/a.test.ts"])).touches).toEqual([]);
  });

  it("flags migrations, hot paths and security paths", () => {
    expect(classifyPr(facts(["db/migrations/001.sql"])).touches).toEqual(["migration"]);
    expect(classifyPr(facts(["packages/code-graph/src/indexer.ts", "packages/code-graph/src/indexer.test.ts"])).touches).toEqual(["perf"]);
    expect(classifyPr(facts(["packages/egress-scan/README.md"])).touches).toEqual(["security"]);
  });

  it("forces security from the kind", () => {
    const result = classifyPr(facts(["docs/a.md"], { kind: "security" }));
    expect(result).toEqual({ class: "g10", touches: ["security"] });
  });

  it("takes the strict class for an absent or unknown kind", () => {
    expect(classifyPr(facts(["docs/a.md"], { kind: undefined })).class).toBe("g10");
    expect(classifyPr(facts(["docs/a.md"], { kind: "unknown" })).class).toBe("g10");
  });

  it("honours authorityTouch and policyTouch when no path matches", () => {
    const result = classifyPr(facts(["docs/a.md"], { authorityTouch: true, policyTouch: true }));
    expect(result).toEqual({ class: "g10", touches: ["authority", "policy"] });
  });

  it("is large past 400 changed lines and not at 400", () => {
    const at = { ...facts([]), changedFiles: [file("docs/a.md", 300, 100)] };
    const over = { ...facts([]), changedFiles: [file("docs/a.md", 300, 101)] };
    expect(classifyPr(at)).toEqual({ class: "standard", touches: [] });
    expect(classifyPr(over)).toEqual({ class: "g10", touches: ["large"] });
  });

  it("falls back to file count when line counts are absent", () => {
    const bare = (n: number) => Array.from({ length: n }, (_, i) => ({ path: `docs/${i}.md` }) as unknown as ChangedFile);
    expect(classifyPr({ ...facts([]), changedFiles: bare(12) }).touches).toEqual([]);
    expect(classifyPr({ ...facts([]), changedFiles: bare(13) }).touches).toEqual(["large"]);
  });

  it("lets rules override the default tables", () => {
    const rules = { ...DEFAULT_CLASS_RULES, policy: ["docs/**"], largeLines: 3 };
    expect(classifyPr(facts(["docs/a.md"]), rules).touches).toEqual(["policy", "large"]);
  });
});
