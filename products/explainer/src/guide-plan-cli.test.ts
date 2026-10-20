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
});
