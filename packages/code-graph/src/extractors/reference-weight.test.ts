import { describe, it, expect } from "vitest";
import { Project } from "ts-morph";
import { namespaceMemberUsage, WHOLE_NAMESPACE } from "./reference-weight.js";

function usageOf(code: string): Record<string, number> {
  const project = new Project({ useInMemoryFileSystem: true });
  const sf = project.createSourceFile("/repo/x.ts", code);
  return Object.fromEntries(namespaceMemberUsage(sf, "S"));
}

describe("namespaceMemberUsage (TP-2474 c)", () => {
  it("counts property, qualified-type and string element accesses per member", () => {
    const usage = usageOf(
      `import * as S from "./s.js";\nconst v: S.T = S.a() + S.a + S["b"];\n`,
    );
    expect(usage).toEqual({ T: 1, a: 2, b: 1 });
  });

  it("ignores the import itself and same-named property positions", () => {
    const usage = usageOf(
      `import * as S from "./s.js";\nconst o = { S: 1 };\nconst n = o.S + S.a;\n`,
    );
    expect(usage).toEqual({ a: 1 });
  });

  it("counts escaping uses of the namespace object as whole-namespace", () => {
    const usage = usageOf(
      `import * as S from "./s.js";\n` +
        `declare function f(x: unknown): void;\n` +
        `f(S);\nconst k = Object.keys(S);\ntype M = typeof S;\nexport { S };\nconst d = S[k[0]!];\n`,
    );
    expect(usage).toEqual({ [WHOLE_NAMESPACE]: 5 });
  });
});
