import { describe, expect, it } from "vitest";
import { parseFile } from "@titan-design/code-parser";
import { computeSourceMetrics } from "../source-metrics.js";
import { identifierTokens } from "./narrating-comments.js";

const lines = (...ls: string[]): string => `${ls.join("\n")}\n`;

async function narrating(code: string, lang: "typescript" | "python", name = "f"): Promise<number | undefined> {
  const fp = lang === "python" ? "f.py" : "f.ts";
  const file = await parseFile(code, fp, lang);
  const metrics = computeSourceMetrics([file], (p) => p, new Map([[fp, new Set([name])]]));
  return metrics.find((m) => m.nodeId === `${fp}#${name}` && m.name === "symbol_narrating_comments")?.value ?? undefined;
}

describe("identifierTokens", () => {
  it("splits camelCase, snake_case and punctuation, and drops short words and stopwords", () => {
    expect([...identifierTokens("// increment the retryCount of user_session")]).toEqual([
      "increment", "retry", "count", "user", "session",
    ]);
  });
});

describe("symbol_narrating_comments on TypeScript (TP-322)", () => {
  it("counts a comment that restates the statement below it", async () => {
    const code = lines("function f(user) {", "  // save the user record", "  saveUserRecord(user);", "}");
    expect(await narrating(code, "typescript")).toBe(1);
  });

  it("does not count a comment that explains why", async () => {
    const code = lines(
      "function f(user) {",
      "  // the upstream API rejects writes during a migration window",
      "  saveUserRecord(user);",
      "}",
    );
    expect(await narrating(code, "typescript")).toBe(0);
  });

  it("compares a trailing comment with the statement it trails", async () => {
    const code = lines("function f(n) {", "  let total = n; // set the total", "  return total;", "}");
    expect(await narrating(code, "typescript")).toBe(1);
  });

  it("does not count a comment with no statement after it", async () => {
    const code = lines("function f(total) {", "  return total;", "  // total", "}");
    expect(await narrating(code, "typescript")).toBe(0);
  });
});

describe("symbol_narrating_comments on Python (TP-322)", () => {
  it("counts each comment of a run that narrates the statement below the run", async () => {
    const code = lines(
      "def f(rows):",
      "    # load the rows",
      "    # from the rows cache",
      "    data = load_rows(rows_cache)",
      "    return data",
    );
    expect(await narrating(code, "python")).toBe(2);
  });

  it("ignores the docstring and keeps a why-comment unflagged", async () => {
    const code = lines(
      "def f(rows):",
      '    """Load the rows."""',
      "    # pandas copies on slice, so take a view first",
      "    data = load_rows(rows)",
      "    return data",
    );
    expect(await narrating(code, "python")).toBe(0);
  });
});
