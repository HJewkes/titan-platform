import { describe, expect, it } from "vitest";
import type { BundleGit } from "../../review-pr/bundle.js";
import { buildReference, estimateTokens, REFERENCE_MAX_TOKENS } from "./reference.js";

const TEST_BODY = "expect(secretAssertion).toBe(42)";

function fileDiff(path: string, body: string): string {
  return `diff --git a/${path} b/${path}\nindex 1111111..2222222 100644\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n${body}\n`;
}

/** Answers `diff --stat` and `diff` per merge from canned text; anything else is a call the reference must not make. */
function fakeGit(diffs: Readonly<Record<string, string>>): BundleGit {
  return {
    git: (args) => {
      const sha = args.at(-1) ?? "";
      if (args[0] === "diff" && args[1]?.startsWith("--stat")) return Promise.resolve(Buffer.from(` src/a.ts | 2 +-\n src/a.test.ts | 2 +-\n`));
      if (args[0] === "diff") return Promise.resolve(Buffer.from(diffs[sha] ?? ""));
      return Promise.reject(new Error(`unexpected git ${args.join(" ")}`));
    },
  };
}

const landed = [
  { pr: 101, mergeSha: "m1", title: "Add the parser (#101)" },
  { pr: 102, mergeSha: "m2", title: "Wire the parser (#102)" },
];

describe("buildReference", () => {
  it("holds PR titles, stats and source diffs but no test-file bodies", async () => {
    const git = fakeGit({
      m1: fileDiff("src/parse.ts", "+export const parse = 1;") + fileDiff("src/parse.test.ts", `+${TEST_BODY}`),
      m2: fileDiff("src/__tests__/wire.ts", `+${TEST_BODY}`) + fileDiff("src/wire.ts", "+export const wire = 2;") + fileDiff("test/helper.mjs", `+${TEST_BODY}`),
    });

    const reference = await buildReference(git, landed);

    expect(reference).toContain("- Wire the parser (#102)");
    expect(reference).toContain("src/a.test.ts | 2 +-");
    expect(reference).toContain("+export const parse = 1;");
    expect(reference).toContain("+export const wire = 2;");
    expect(reference).not.toContain(TEST_BODY);
  });

  it("fits under 30k tokens when the merged diff is far larger", async () => {
    const huge = Array.from({ length: 4000 }, (_, index) => fileDiff(`src/file-${index}.ts`, `+export const value${index} = "${"x".repeat(60)}";`)).join("");

    const reference = await buildReference(fakeGit({ m1: huge, m2: huge }), landed);

    expect(estimateTokens(reference)).toBeLessThanOrEqual(REFERENCE_MAX_TOKENS);
    expect(reference).toContain("- Add the parser (#101)");
    expect(reference).toMatch(/reference cut here/);
  });
});
