import { describe, expect, it } from "vitest";

import { planSliceExcerpt, touchPointsIn } from "./plan-slice.js";

describe("planSliceExcerpt", () => {
  it("takes the whole section under a heading that names the slice, up to the next heading at its level", () => {
    const plan = "# Plan\n## W1 parse\nbody one\n### detail\nmore\n## W2 render\nother";

    expect(planSliceExcerpt(plan, "W1")).toBe("## W1 parse\nbody one\n### detail\nmore");
  });

  it("collects the rows and paragraphs that mention the slice id as a whole word", () => {
    const plan = "| id | x |\n|---|---|\n| W1 | parse |\n| W10 | other |\n\nW1 runs first.\n\nW2 runs after.";

    expect(planSliceExcerpt(plan, "W1")).toBe("| W1 | parse |\n\nW1 runs first.");
  });

  it("gives null when nothing in the plan names the slice", () => {
    expect(planSliceExcerpt("# Plan\nnothing here", "W9")).toBeNull();
  });
});

describe("touchPointsIn", () => {
  it("lists each backticked repo path once, with its first line number, up to the limit", () => {
    const text = "`src/a.ts:10-20`, `src/a.ts:40`, `src/b/c.md`, `../outside/x.ts`, `src/d.ts`";

    expect(touchPointsIn(text, 2)).toEqual([{ path: "src/a.ts", line: 10 }, { path: "src/b/c.md" }]);
    expect(touchPointsIn(text, 8).map((p) => p.path)).not.toContain("../outside/x.ts");
  });
});
