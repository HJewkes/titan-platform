import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { MINER_VERSION } from "./registry.js";

describe("MINER_VERSION", () => {
  it("equals the version in package.json", () => {
    const pkg = createRequire(import.meta.url)("../package.json") as { version: string };

    expect(MINER_VERSION).toBe(pkg.version);
  });
});
