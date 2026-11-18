import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isCodeEnforced } from "./doctrine-checks.js";
import { DEFAULT_DOCTRINE_DIR, loadDoctrine } from "./doctrine-load.js";
import { DOCTRINE_STAGES, type DoctrineRule } from "./doctrine-schema.js";
import { craftRule, registryWith } from "./doctrine-fixtures.test-helpers.js";
import { sliceForStage } from "./doctrine-slice.js";
import { loadRuleRegistry, resolveRule } from "./rules.js";

interface ChecklistRow {
  source: string;
  ref: string;
  layer: string;
}

const parseChecklist = (text: string): ChecklistRow[] =>
  text
    .split("\n")
    .slice(1)
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const [source = "", ref = "", layer = ""] = line.split("\t");
      return { source, ref, layer };
    });

const shippedChecklist = (): ChecklistRow[] => parseChecklist(readFileSync(join(DEFAULT_DOCTRINE_DIR, "section4-ids.tsv"), "utf8"));

const hasCraftFile = (source: string): boolean => existsSync(join(DEFAULT_DOCTRINE_DIR, "craft", `${source}.yaml`));

/** The checklist rows that have no rule with the same source, ref and layer, among sources that have a craft file. */
const uncoveredRows = (rows: ChecklistRow[], rules: DoctrineRule[], hasFile: (source: string) => boolean): ChecklistRow[] =>
  rows
    .filter(({ source }) => hasFile(source))
    .filter(({ source, ref, layer }) => !rules.some((rule) => rule.source.doc === source && rule.source.ref === ref && rule.scope.layer === layer));

const label = ({ source, ref, layer }: ChecklistRow): string => `${source} ${ref} (${layer})`;

describe("the VT §4 id checklist", () => {
  it("is covered by a rule with the same ref and layer for every source that has a craft file", () => {
    const missing = uncoveredRows(shippedChecklist(), loadDoctrine().rules, hasCraftFile);

    expect(missing.map(label)).toEqual([]);
  });

  it("fails the coverage helper on a checklist row that no rule covers", () => {
    const covered = craftRule({ id: "talks-O1", source: { doc: "talks-and-slides", ref: "O1" }, scope: { layer: "U*" }, param: "throughline" });
    const rows: ChecklistRow[] = [
      { source: "talks-and-slides", ref: "O1", layer: "U*" },
      { source: "talks-and-slides", ref: "O2", layer: "U" },
    ];

    const missing = uncoveredRows(rows, registryWith(covered).rules, () => true);

    expect(missing.map(label)).toEqual(["talks-and-slides O2 (U)"]);
  });

  it("asks a split row for a rule in each of its layers", () => {
    const first = craftRule({ id: "talks-B4", source: { doc: "talks-and-slides", ref: "B4" }, scope: { layer: "T", types: ["repo-tour"] } });
    const rows: ChecklistRow[] = [
      { source: "talks-and-slides", ref: "B4", layer: "T" },
      { source: "talks-and-slides", ref: "B4", layer: "B" },
    ];

    expect(uncoveredRows(rows, [first], () => true).map(label)).toEqual(["talks-and-slides B4 (B)"]);
  });

  it("skips rows whose source has no craft file", () => {
    const rows: ChecklistRow[] = [{ source: "direction", ref: "P1", layer: "U" }];

    expect(uncoveredRows(rows, [], () => false)).toEqual([]);
  });
});

describe("the shipped registries' prompt slices", () => {
  const registry = loadDoctrine();
  const qRules = loadRuleRegistry();
  const codeEnforced = (rule: DoctrineRule): boolean =>
    isCodeEnforced(rule) || (rule.check?.kind === "qrule" && resolveRule(qRules, rule.check.ref)?.l0?.status === "implemented");
  const cases = DOCTRINE_STAGES.flatMap((stage) => registry.vocabulary.types.map((type) => ({ stage, type })));

  it.each(cases)("puts no code-enforced rule in prompt, base or packet for $stage on $type", ({ stage, type }) => {
    const beats = registry.vocabulary.beats;
    const { prompt, base, packet } = sliceForStage(registry, qRules, { stage, type, beats });

    const leaked = [...prompt, ...base, ...packet].filter(codeEnforced).map((rule) => rule.id);

    expect(leaked).toEqual([]);
  });
});
