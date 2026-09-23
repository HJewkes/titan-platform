import { describe, expect, it } from "vitest";
import * as path from "node:path";
import {
  externalId,
  fileId,
  moduleId,
  packageId,
  parentModuleId,
  parseSymbolId,
  symbolId,
} from "./ids.js";

describe("node ids", () => {
  it("roots a file id at the repo root as a posix path", () => {
    expect(fileId("/repo", "/repo/packages/a/src/index.ts")).toBe("packages/a/src/index.ts");
  });

  it("strips the module extension for a module id, TypeScript and Python alike", () => {
    expect(moduleId("/repo", "/repo/src/a.ts")).toBe("src/a");
    expect(moduleId("/repo", "/repo/src/a.tsx")).toBe("src/a");
    expect(moduleId("/repo", "/repo/src/a.py")).toBe("src/a");
  });

  it("walks module ids up one directory at a time and stops at the root", () => {
    expect(parentModuleId("src/a/b")).toBe("src/a");
    expect(parentModuleId("src")).toBeNull();
  });

  it("hangs symbol ids under their declaring file and splits back", () => {
    const id = symbolId("src/a.ts", "createThing");
    expect(id).toBe("src/a.ts#createThing");
    expect(parseSymbolId(id)).toEqual({ fileId: "src/a.ts", name: "createThing" });
    expect(parseSymbolId("src/a.ts")).toBeNull();
  });

  it("buckets an external specifier by package, keeping node: builtins whole", () => {
    expect(externalId("@titan-design/registry/sub")).toBe("npm:@titan-design/registry");
    expect(externalId("zod")).toBe("npm:zod");
    expect(externalId("node:path")).toBe("node:path");
  });
});

const ROOT = path.resolve("/repo");

describe("fileId", () => {
  it("returns the repo-relative path with extension", () => {
    expect(fileId(ROOT, path.join(ROOT, "src", "index.ts"))).toBe("src/index.ts");
  });

  it("preserves tsx extensions", () => {
    expect(fileId(ROOT, path.join(ROOT, "src", "App.tsx"))).toBe("src/App.tsx");
  });
});

describe("moduleId", () => {
  it("strips the .ts extension", () => {
    expect(moduleId(ROOT, path.join(ROOT, "src", "index.ts"))).toBe("src/index");
  });

  it("strips the .tsx extension", () => {
    expect(moduleId(ROOT, path.join(ROOT, "src", "App.tsx"))).toBe("src/App");
  });

  it("strips .mts and .cts extensions", () => {
    expect(moduleId(ROOT, path.join(ROOT, "src", "a.mts"))).toBe("src/a");
    expect(moduleId(ROOT, path.join(ROOT, "src", "b.cts"))).toBe("src/b");
  });
});

describe("parentModuleId", () => {
  it("returns the parent directory", () => {
    expect(parentModuleId("packages/graph/src/index")).toBe("packages/graph/src");
  });

  it("returns null at the repo root", () => {
    expect(parentModuleId("index")).toBeNull();
  });
});

describe("packageId", () => {
  it("returns the package name unchanged", () => {
    expect(packageId("@codewatch/graph")).toBe("@codewatch/graph");
    expect(packageId("better-sqlite3")).toBe("better-sqlite3");
  });
});

describe("externalId", () => {
  it("preserves node: builtins verbatim", () => {
    expect(externalId("node:fs/promises")).toBe("node:fs/promises");
    expect(externalId("node:fs")).toBe("node:fs");
  });

  it("strips subpaths from bare npm packages", () => {
    expect(externalId("typescript")).toBe("npm:typescript");
    expect(externalId("foo/bar")).toBe("npm:foo");
    expect(externalId("lodash/fp/flow")).toBe("npm:lodash");
  });

  it("preserves scope when stripping subpaths from scoped packages", () => {
    expect(externalId("@scope/pkg")).toBe("npm:@scope/pkg");
    expect(externalId("@scope/pkg/sub")).toBe("npm:@scope/pkg");
    expect(externalId("@codewatch/core/foo/bar")).toBe("npm:@codewatch/core");
  });
});
