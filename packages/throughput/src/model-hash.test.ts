import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PACKAGE_VERSION, readPackageVersion } from "./model-hash.js";

describe("PACKAGE_VERSION", () => {
  it("equals the package's own version", () => {
    const manifest: unknown = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(PACKAGE_VERSION).toBe(Reflect.get(Object(manifest), "version"));
  });

  it("refuses a manifest whose version is not a string", () => {
    expect(() => readPackageVersion({ version: 3 })).toThrow("no string version");
    expect(() => readPackageVersion(null)).toThrow("no string version");
  });

  it("reads a string version", () => {
    expect(readPackageVersion({ version: "1.2.3" })).toBe("1.2.3");
  });
});
