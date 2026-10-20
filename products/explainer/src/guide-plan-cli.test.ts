import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runGuideCli } from "./guide-plan-cli.js";

async function run(argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runGuideCli(argv, {}, { out: (text) => out.push(text), err: (text) => err.push(text) });
  return { code, out: out.join(""), err: err.join("") };
}

describe("explainer guide plan", () => {
  it("prints the script-stage guide as markdown with --stage script", async () => {
    const { code, out } = await run(["guide", "plan", "--stage", "script"]);

    expect(code).toBe(0);
    expect(out).toContain("## Rules for the script stage");
    expect(out).toContain("## Spine template");
  });

  it("defaults to the plan stage", async () => {
    const { out } = await run(["guide", "plan"]);

    expect(out).toContain("## Rules for the plan stage");
  });

  it("exits 2 on an unknown stage", async () => {
    const { code } = await run(["guide", "plan", "--stage", "render"]);

    expect(code).toBe(2);
  });

  it("appends the spine's acts with --spine", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "guide-spine-")), "spine.md");
    writeFileSync(file, `# Story spine: x

## 3. Journey
| # | Step | What | Why | Inv | Breaks |
|---|---|---|---|---|---|
| 1 | Scan | reads | needed | — | — |

## 4. Architecture
| Part | Carries | Mech | Constraint |
|---|---|---|---|
| Desk | 1 | — | — |

## 5. Constraints
| Constraint | Forces |
|---|---|

## 6. Item ledger
| Item | Kind | Defined | Reused |
|---|---|---|---|
| Desk | part | c2-1 | — |

## 8. Chapter order
| Ch | Question | Rows |
|---|---|---|
| ch2 | Why? | §3.1 |
`);
    const { code, out } = await run(["guide", "plan", "--spine", file]);

    expect(code).toBe(0);
    expect(out).toContain("### ch2: Why?");
  });
});
