import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./cli.js";

describe("runCli enum options", () => {
  afterEach(() => vi.restoreAllMocks());

  async function failure(argv: string[]): Promise<{ code: number; message: string }> {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const code = await runCli(argv);
    return { code, message: errors.mock.calls.map((call) => String(call[0])).join("\n") };
  }

  it("rejects an unknown mine --arm and names the allowed arms", async () => {
    const { code, message } = await failure(["mine", "--arm", "spwan"]);
    expect(code).toBe(1);
    expect(message).toContain("spawn, bootstrap, both");
  });

  it("rejects an unknown run --variants and names the allowed variants", async () => {
    const { code, message } = await failure(["run", "pairs.jsonl", "--variants", "bogus"]);
    expect(code).toBe(1);
    expect(message).toContain("heading-lead, top-df");
  });

  it("rejects an unknown run --candidates and names the allowed candidates", async () => {
    const { code, message } = await failure(["run", "pairs.jsonl", "--candidates", "bogus"]);
    expect(code).toBe(1);
    expect(message).toContain("date-order-notes, active-work-search, notes-fts, hybrid-fts-vector");
  });
});
