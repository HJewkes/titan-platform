import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PACKAGE_VERSION } from "./model-hash.js";

describe("PACKAGE_VERSION", () => {
  it("equals the package's own version", () => {
    const manifest: unknown = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(PACKAGE_VERSION).toBe(Reflect.get(Object(manifest), "version"));
  });
});
