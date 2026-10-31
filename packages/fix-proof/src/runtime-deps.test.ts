import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The path lists that protect this package's decisions (the authority touch globs, the carry fence, the
// shape safety list) see only its own files, so a runtime dependency would put decision code outside them.
describe("the package manifest", () => {
  it("has no runtime dependencies", () => {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { dependencies?: object };

    expect(manifest.dependencies ?? {}).toEqual({});
  });
});
