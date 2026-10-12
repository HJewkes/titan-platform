import { partialFake } from "@titan-design/test-kit";
import { describe, expect, it } from "vitest";
import { changedLineCount, classifyPr, DEFAULT_CLASS_RULES, SECURITY_SLICE_LINES, securitySliceFlag } from "./classify.js";
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

  it("leaves generated registry files out of the changed-line count", () => {
    const changedFiles = [file("packages/a/src/a.ts", 20, 1), file("CAPABILITIES.md", 200, 80), file("site/reference/a.md", 60, 0), file("site/.vitepress/reference-sidebar.json", 20, 0), file("site/guides/capabilities.md", 10, 0), file(".codewatch/check.json", 10, 0)];
    expect(changedLineCount(changedFiles)).toBe(21);
    expect(classifyPr({ ...facts([]), changedFiles }).touches).not.toContain("large");
  });

  it("counts no lines when any file lacks them, generated or not", () => {
    const bare = partialFake<ChangedFile>({ path: "docs/a.md" });
    const bareGenerated = partialFake<ChangedFile>({ path: "CAPABILITIES.md" });
    expect(changedLineCount([file("docs/b.md"), bare])).toBeUndefined();
    expect(changedLineCount([file("docs/b.md"), bareGenerated])).toBeUndefined();
  });

  it("counts every line once generated files alone pass the large limit", () => {
    const changedFiles = [file("packages/a/src/a.ts", 10, 0), file("site/reference/a.md", 5000, 0)];
    expect(changedLineCount(changedFiles)).toBe(5010);
    expect(classifyPr({ ...facts([]), changedFiles }).touches).toContain("large");
  });

  it("counts a rename into a generated path against the path it left", () => {
    const renamed = { ...file("site/reference/a.md", 0, 450), previousPath: "packages/a/src/a.ts" };
    expect(changedLineCount([renamed])).toBe(450);
  });

  it("falls back to file count when line counts are absent", () => {
    const bare = (n: number) => Array.from({ length: n }, (_, i) => partialFake<ChangedFile>({ path: `docs/${i}.md` }));
    expect(classifyPr({ ...facts([]), changedFiles: bare(12) }).touches).toEqual([]);
    expect(classifyPr({ ...facts([]), changedFiles: bare(13) }).touches).toEqual(["large"]);
  });

  it("lets rules override the default tables", () => {
    const rules = { ...DEFAULT_CLASS_RULES, policy: ["docs/**"], largeLines: 3 };
    expect(classifyPr(facts(["docs/a.md"]), rules).touches).toEqual(["policy", "large"]);
  });
});

describe("securitySliceFlag", () => {
  const guard = "packages/tool-guard/src/x.ts";

  it("leaves changeset, API report and dead-export churn out of a guard slice's size", () => {
    const changedFiles = [file(guard, 350, 0), file(".changeset/a.md", 5, 0), file("packages/tool-guard/api/index.d.ts", 40, 0), file(".codewatch/dead-exports.json", 20, 0)];
    expect(changedLineCount(changedFiles)).toBe(350);
    expect(securitySliceFlag({ changedFiles })).toBeUndefined();
  });

  it("flags a guard-area slice one line over the cap and not one at it", () => {
    expect(SECURITY_SLICE_LINES).toBe(400);
    expect(securitySliceFlag({ changedFiles: [file(guard, 300, 101)] })).toEqual({ lines: 401, cap: 400, guardPaths: [guard] });
    expect(securitySliceFlag({ changedFiles: [file(guard, 300, 100)] })).toBeUndefined();
  });

  it("flags an oversize kind security slice whatever its paths", () => {
    const changedFiles = [file("src/foo.ts", 450, 0)];
    expect(securitySliceFlag({ kind: "security", changedFiles })).toEqual({ lines: 450, cap: 400, guardPaths: [] });
    expect(securitySliceFlag({ changedFiles })).toBeUndefined();
    expect(securitySliceFlag({ kind: "correctness", changedFiles })).toBeUndefined();
  });

  it("counts authority paths as a guard area", () => {
    const path = "products/factory/src/shepherd/merge-facts.ts";
    expect(securitySliceFlag({ changedFiles: [file(path, 500, 0)] })?.guardPaths).toEqual([path]);
  });

  it("does not treat a generated file under an authority glob as a guard path", () => {
    expect(securitySliceFlag({ changedFiles: [file(".codewatch/check.json", 500, 0)] })).toBeUndefined();
  });

  it("flags nothing when a count is unreadable", () => {
    const bare = partialFake<ChangedFile>({ path: guard });
    expect(securitySliceFlag({ kind: "security", changedFiles: [file(guard, 900, 0), bare] })).toBeUndefined();
  });
});

describe("classifyPr hand-editable paths", () => {
  const std = (changedFiles: ChangedFile[]) => classifyPr(facts([], { kind: "correctness", changedFiles }));

  it("classes a 300-line src change plus a lockfile change g10 with a dependency touch", () => {
    const result = std([file("src/a.ts", 300, 0), file("pnpm-lock.yaml", 10, 0)]);
    expect(result.class).toBe("g10");
    expect(result.touches).toContain("dependency");
  });

  it("classes a package.json change g10", () => {
    expect(std([file("packages/x/package.json", 1, 1)]).class).toBe("g10");
  });

  it("counts a lockfile as real lines rather than generated", () => {
    expect(changedLineCount([file("src/a.ts", 300, 0), file("pnpm-lock.yaml", 200, 0)])).toBe(500);
  });

  it.each(["src/__snapshots__/evil.ts", "products/x/src/api/y.d.ts", "src/__snapshots__/x.snap"])("counts %s as real lines", (path) => {
    expect(changedLineCount([file(path, 50, 0)])).toBe(50);
  });
});
