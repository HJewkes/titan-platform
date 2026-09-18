import { describe, it, expect } from "vitest";
import {
  parseEslintJsonOutput,
  parseRuffJsonOutput,
  formatDiagnostic,
} from "./unified.js";
import type { CheckDiagnostic } from "../orchestrator/types.js";

describe("parseEslintJsonOutput", () => {
  it("normalizes ESLint JSON output to CheckDiagnostic[]", () => {
    const eslintOutput = [
      {
        filePath: "/src/app.ts",
        messages: [
          {
            ruleId: "@typescript-eslint/naming-convention",
            severity: 2,
            message: "Variable name 'my_var' must match camelCase format.",
            line: 10,
            column: 7,
            fix: null,
          },
          {
            ruleId: "max-lines-per-function",
            severity: 1,
            message:
              "Function has too many lines (45). Maximum allowed is 28.",
            line: 20,
            column: 1,
            fix: null,
          },
        ],
      },
    ];

    const diagnostics = parseEslintJsonOutput(JSON.stringify(eslintOutput));
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics[0]!.file).toBe("/src/app.ts");
    expect(diagnostics[0]!.line).toBe(10);
    expect(diagnostics[0]!.column).toBe(7);
    expect(diagnostics[0]!.severity).toBe("error");
    expect(diagnostics[0]!.rule).toBe(
      "@typescript-eslint/naming-convention",
    );
    expect(diagnostics[0]!.category).toBe("naming");
    expect(diagnostics[1]!.severity).toBe("warn");
  });

  it("skips messages without ruleId", () => {
    const input = JSON.stringify([
      {
        filePath: "/src/index.ts",
        messages: [
          {
            ruleId: null,
            severity: 1,
            message: "parse error",
            line: 1,
            column: 1,
          },
        ],
      },
    ]);
    const result = parseEslintJsonOutput(input);
    expect(result).toHaveLength(0);
  });

  it("throws on non-JSON input", () => {
    expect(() =>
      parseEslintJsonOutput("Error: something went wrong\n"),
    ).toThrow(/Failed to parse ESLint JSON output/);
  });
});

describe("parseRuffJsonOutput", () => {
  it("normalizes Ruff JSON output to CheckDiagnostic[]", () => {
    const ruffOutput = [
      {
        code: "N806",
        message: "Variable in function should be lowercase",
        filename: "/src/app.py",
        location: { row: 5, column: 4 },
        end_location: { row: 5, column: 12 },
        fix: null,
      },
    ];

    const diagnostics = parseRuffJsonOutput(JSON.stringify(ruffOutput));
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.file).toBe("/src/app.py");
    expect(diagnostics[0]!.line).toBe(5);
    expect(diagnostics[0]!.column).toBe(4);
    expect(diagnostics[0]!.rule).toBe("N806");
    expect(diagnostics[0]!.category).toBe("naming");
  });

  it("throws on non-JSON input", () => {
    expect(() =>
      parseRuffJsonOutput("ruff: error: invalid config\n"),
    ).toThrow(/Failed to parse Ruff JSON output/);
  });
});

describe("formatDiagnostic", () => {
  it("formats as {file}:{line}:{col} {severity} {message} [{category}.{rule}]", () => {
    const d: CheckDiagnostic = {
      file: "src/app.ts",
      line: 10,
      column: 7,
      severity: "error",
      message: "Variable must be camelCase",
      category: "naming",
      rule: "naming-convention",
      fixable: false,
    };
    const output = formatDiagnostic(d);
    expect(output).toBe(
      "src/app.ts:10:7 error Variable must be camelCase [naming.naming-convention]",
    );
  });
});
