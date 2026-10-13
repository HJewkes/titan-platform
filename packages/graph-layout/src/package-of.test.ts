import { describe, it, expect } from "vitest";
import { packageOf } from "./package-of.js";

describe("packageOf", () => {
  it("names a packages/ file by its package directory", () => {
    expect(packageOf("packages/graph/src/a.ts")).toBe("graph");
  });

  it("gives each product and app its own package, keeping the root so names cannot collide", () => {
    expect(packageOf("products/alpha/src/a.ts")).toBe("products/alpha");
    expect(packageOf("products/beta/b.ts")).toBe("products/beta");
    expect(packageOf("apps/graph/src/c.ts")).toBe("apps/graph");
    expect(packageOf("packages/graph/src/c.ts")).not.toBe(packageOf("apps/graph/src/c.ts"));
  });

  it("falls back to the first path segment outside a workspace member", () => {
    expect(packageOf("scripts/build.mjs")).toBe("scripts");
    expect(packageOf("products/readme.ts")).toBe("products");
    expect(packageOf("root.ts")).toBe("root.ts");
  });
});
