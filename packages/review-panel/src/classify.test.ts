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

  it("classifies tp#755's changed files as authority and policy", () => {
    const result = classifyPr(
      facts([
        "packages/authority/src/conditions.ts",
        "packages/authority/src/merge-carry.test.ts",
        "products/factory/src/shepherd/merge-facts.ts",
        "products/factory/src/shepherd/merge-facts.test.ts",
        "products/factory/src/shepherd/policy.test.ts",
        "site/reference/authority.md",
      ]),
    );
    expect(result).toEqual({ class: "g10", touches: ["authority", "policy"] });
  });

  it("classifies tp#747's required-checks policy files as authority and policy", () => {
    const result = classifyPr(facts(["products/factory/src/required-checks-policy.ts", "products/factory/src/required-checks-policy.test.ts"]));
    expect(result).toEqual({ class: "g10", touches: ["authority", "policy"] });
  });

  it("classifies tp#754's changed files as policy and large, not security", () => {
    const changedFiles = [
      file("packages/hitl/src/resolver-policy.ts", 50, 9),
      file("packages/hitl/src/evidence.test.ts", 166, 0),
      file("products/factory/src/coordinator-evidence.ts", 225, 0),
      file("products/factory/src/test-support/authority-reason.ts", 29, 0),
    ];
    expect(classifyPr(facts([], { changedFiles }))).toEqual({ class: "g10", touches: ["policy", "large"] });
  });

  it("treats a gate schema file as policy", () => {
    expect(classifyPr(facts(["packages/gates/src/gate-schema.json"])).touches).toEqual(["policy"]);
  });

  it("does not read authority, holder or ticket files as auth, hold or tick files", () => {
    const result = classifyPr(facts(["packages/x/src/authority-reason.ts", "packages/x/src/holder.ts", "packages/x/src/ticket.ts", "packages/x/src/a.test.ts"]));
    expect(result).toEqual({ class: "standard", touches: [] });
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
