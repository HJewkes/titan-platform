import { describe, expect, it } from "vitest";
import { classProblems, collectRuleClasses, renderRegistry } from "./checks-registry.mjs";

const rule = (classes) => ({ meta: { docs: { description: "d", classes } }, create: () => ({}) });

function checkWith(classes) {
  const check = () => [];
  if (classes) check.classes = classes;
  return check;
}

const sources = {
  eslintRules: { "max-function-lines": rule(["complexity"]) },
  structureModule: { checkPnpmPin: checkWith(["release-ordering"]), workspaceMemberDirs: () => [] },
  checkRules: [{ id: "max-file-loc", type: "metric-max", $classes: ["complexity"] }],
};

describe("collectRuleClasses", () => {
  it("names each rule by its source and keeps its classes", () => {
    expect(collectRuleClasses(sources)).toEqual([
      ["codewatch/max-file-loc", ["complexity"]],
      ["structure/checkPnpmPin", ["release-ordering"]],
      ["titan/max-function-lines", ["complexity"]],
    ]);
  });

  it("lists a structure check that names no classes with an empty list", () => {
    const entries = collectRuleClasses({ ...sources, structureModule: { checkBare: checkWith(undefined) } });
    expect(entries).toContainEqual(["structure/checkBare", []]);
  });
});

describe("classProblems", () => {
  it("accepts keys from the fixed vocabulary and other:<slug> keys", () => {
    expect(classProblems([["titan/a", ["swallowed-error", "other:import-boundary"]]])).toEqual([]);
  });

  it("reports a rule that names no class", () => {
    expect(classProblems([["codewatch/bare", []]])).toEqual([
      "`codewatch/bare` names no class key. Add the review-finding classes it catches (scripts/checks-registry.mjs lists them).",
    ]);
  });

  it("reports a key outside the vocabulary, including a malformed other: key", () => {
    expect(classProblems([["titan/a", ["swallowed-errors", "other:Bad Slug"]]])).toEqual([
      "`titan/a` names `swallowed-errors`, which is not a class key. Use a key from scripts/checks-registry.mjs, or `other:<kebab-slug>`.",
      "`titan/a` names `other:Bad Slug`, which is not a class key. Use a key from scripts/checks-registry.mjs, or `other:<kebab-slug>`.",
    ]);
  });
});

describe("renderRegistry", () => {
  it("writes rule id -> classes as stable JSON with a trailing newline", () => {
    const text = renderRegistry([["titan/a", ["complexity"]]]);
    expect(JSON.parse(text).rules).toEqual({ "titan/a": ["complexity"] });
    expect(text.endsWith("}\n")).toBe(true);
  });
});
