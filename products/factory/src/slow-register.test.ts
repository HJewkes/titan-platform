import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineCommand } from "@titan-design/registry";
import type { FactoryContext } from "./registry.js";
import { logSlowRegister } from "./slow-register.js";

function setup(takesMs: number, name = "shepherd.register") {
  let clock = 0;
  const warnings: { fields: Record<string, unknown>; message: string }[] = [];
  const log = { info: () => undefined, error: () => undefined, warn: (fields: Record<string, unknown>, message: string) => void warnings.push({ fields, message }) };
  const cmd = defineCommand<{ repo: string }, string, FactoryContext>({
    name,
    description: "test",
    args: z.object({ repo: z.string() }),
    result: z.string(),
    run: async () => ((clock += takesMs), "done"),
  });
  const wrapped = logSlowRegister(cmd, log, () => clock);
  return { wrapped, warnings };
}

describe("logSlowRegister", () => {
  it("warns with the elapsed time and repo when a register takes longer than 5 s", async () => {
    const { wrapped, warnings } = setup(6200);

    await expect(wrapped.run({ repo: "o/r" }, {} as FactoryContext)).resolves.toBe("done");

    expect(warnings).toEqual([{ fields: { command: "shepherd.register", repo: "o/r", elapsedMs: 6200 }, message: expect.stringMatching(/slow/) }]);
  });

  it("stays quiet for a register that finishes within 5 s", async () => {
    const { wrapped, warnings } = setup(4999);

    await wrapped.run({ repo: "o/r" }, {} as FactoryContext);

    expect(warnings).toEqual([]);
  });
});
