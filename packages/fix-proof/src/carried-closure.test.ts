import { describe, expect, it } from "vitest";
import { loadsOnlyCarried, runtimeSpecifiers } from "./carried-closure.js";
import { compileGlobs } from "./glob.js";

const isCarried = compileGlobs(["**/test-support/**"]);
const TEST = "pkg/src/test-support/x.test.ts";

function loads(files: Record<string, string>): Promise<boolean> {
  return loadsOnlyCarried(TEST, async (path) => files[path] ?? null, isCarried);
}

describe("loadsOnlyCarried", () => {
  it("accepts a carried test whose imports stay in carry, through carried helpers, besides vitest and node builtins", async () => {
    const result = await loads({
      [TEST]: 'import fs from "node:fs";\nimport path from "path";\nimport { it } from "vitest";\nimport { a } from "./a.js";\n',
      "pkg/src/test-support/a.ts": 'export { b } from "./b.js";\nexport const a = 1;\n',
      "pkg/src/test-support/b.ts": 'import { a } from "./a.js";\nexport const b = a;\n',
    });

    expect(result).toBe(true);
  });

  it("refuses a carried test that imports non-carried source directly", async () => {
    expect(await loads({ [TEST]: 'import { foo } from "../foo.js";\n', "pkg/src/foo.ts": "export const foo = 1;\n" })).toBe(false);
  });

  it("refuses a carried test whose carried helper imports non-carried source", async () => {
    const result = await loads({
      [TEST]: 'import { a } from "./a.js";\n',
      "pkg/src/test-support/a.ts": 'import { host } from "../../host.js";\nexport const a = host;\n',
      "pkg/host.ts": "export const host = 1;\n",
    });

    expect(result).toBe(false);
  });

  it("ignores a type-only import of non-carried source, which the test never loads", async () => {
    const result = await loads({
      [TEST]: 'import type { Hook } from "../hook.js";\nexport type { Other } from "../other.js";\nimport { it } from "vitest";\n',
    });

    expect(result).toBe(true);
  });

  it("refuses a bare package import, which may resolve to workspace source", async () => {
    expect(await loads({ [TEST]: 'import { z } from "@scope/pkg";\n' })).toBe(false);
  });

  it("refuses a relative import that resolves to no file", async () => {
    expect(await loads({ [TEST]: 'import { gone } from "./gone.js";\n' })).toBe(false);
  });

  it("refuses a test that is not carried", async () => {
    const plain = "pkg/src/y.test.ts";

    expect(await loadsOnlyCarried(plain, async () => 'import { it } from "vitest";\n', isCarried)).toBe(false);
  });
});

describe("runtimeSpecifiers", () => {
  it("reads every static, side-effect, dynamic and require load", () => {
    const text = 'import a from "./a.js";\nimport "./b.js";\nconst c = await import("./c.js");\nconst d = require("./d.js");\n';

    expect(runtimeSpecifiers(text)).toEqual(["./a.js", "./b.js", "./c.js", "./d.js"]);
  });

  it("is null for a load whose specifier is computed", () => {
    expect(runtimeSpecifiers("const m = await import(name);\n")).toBeNull();
  });

  it("keeps a runtime import that follows a type alias", () => {
    expect(runtimeSpecifiers('export type Foo = { a: string }\nimport { x } from "../host.js";\n')).toEqual(["../host.js"]);
  });
});
