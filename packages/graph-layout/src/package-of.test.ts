import { describe, it, expect } from "vitest";
import { packageOf, packageRootOf } from "./package-of.js";

describe("packageRootOf", () => {
  it("returns the directory holding each kind of package", () => {
    expect(packageRootOf("packages/graph/src/a.ts")).toBe("packages/graph");
    expect(packageRootOf("products/alpha/src/a.ts")).toBe("products/alpha");
    expect(packageRootOf("apps/graph/c.ts")).toBe("apps/graph");
  });

  it("returns the first path segment for a top-level directory or root file", () => {
    expect(packageRootOf("tools/build.ts")).toBe("tools");
    expect(packageRootOf("root.ts")).toBe("root.ts");
  });
});

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
