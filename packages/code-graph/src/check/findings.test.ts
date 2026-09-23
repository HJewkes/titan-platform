import { describe, expect, it } from "vitest";
import { externalToFinding, toFindings } from "./findings.js";
import type { CheckResult } from "./types.js";

const RESULT: CheckResult = {
  snapshotId: 1,
  rulesEvaluated: 2,
  nodesEvaluated: 1,
  violations: [
    {
      ruleId: "max-symbol-cyclomatic",
      severity: "error",
      nodeId: "src/a.py#tangled",
      message: "symbol_cyclomatic=14 > 10",
      metric: "symbol_cyclomatic",
      value: 14,
      threshold: 10,
      path: "src/a.py",
      lineStart: 3,
      lineEnd: 40,
      symbol: "tangled",
      evidence: "symbol_cyclomatic=14 (max 10)",
      tool: "code-graph",
    },
    {
      ruleId: "no-pad",
      severity: "warning",
      nodeId: "src/b.ts",
      destinationId: "npm:left-pad",
      message: "src/b.ts imports npm:left-pad",
    },
  ],
  newErrors: 1,
  newWarnings: 1,
  carryoverErrors: 0,
  carryoverWarnings: 0,
  passed: false,
};

describe("toFindings", () => {
  it("carries each violation's line range and evidence into one finding", () => {
    const findings = toFindings(RESULT);

    expect(findings).toEqual([
      {
        id: "code-graph:max-symbol-cyclomatic:src/a.py#tangled",
        path: "src/a.py",
        lineStart: 3,
        lineEnd: 40,
        symbol: "tangled",
        signal: "max-symbol-cyclomatic",
        value: 14,
        threshold: 10,
        severity: "error",
        evidence: "symbol_cyclomatic=14 (max 10)",
        tool: "code-graph",
      },
      {
        id: "code-graph:no-pad:src/b.ts->npm:left-pad",
        path: "src/b.ts",
        signal: "no-pad",
        severity: "warning",
        evidence: "src/b.ts imports npm:left-pad",
        tool: "code-graph",
      },
    ]);
  });

  it("gives the same ids on a second call", () => {
    expect(toFindings(RESULT).map((f) => f.id)).toEqual(toFindings(RESULT).map((f) => f.id));
  });
});

describe("externalToFinding", () => {
  const diagnostic = {
    tool: "ruff",
    rule: "C901",
    file: "pkg/mod.py",
    line: 12,
    endLine: 30,
    message: "`load` is too complex (14 > 10)",
    severity: "warning" as const,
  };

  it("maps the rule to the signal and the file to the path", () => {
    expect(externalToFinding(diagnostic)).toEqual({
      id: "ruff:C901:pkg/mod.py:12",
      path: "pkg/mod.py",
      lineStart: 12,
      lineEnd: 30,
      signal: "C901",
      severity: "warning",
      evidence: "`load` is too complex (14 > 10)",
      tool: "ruff",
    });
  });

  it("gives the same id on a second call", () => {
    expect(externalToFinding(diagnostic).id).toBe(externalToFinding({ ...diagnostic }).id);
  });
});
