import { describe, expect, it } from "vitest";
import {
  externalId,
  fileId,
  moduleId,
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
