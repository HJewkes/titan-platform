import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { MINER_VERSION } from "./registry.js";

describe("MINER_VERSION", () => {
  it("equals the version in package.json", () => {
    const pkg = z.object({ version: z.string() }).parse(createRequire(import.meta.url)("../package.json"));

    expect(MINER_VERSION).toBe(pkg.version);
  });
});
