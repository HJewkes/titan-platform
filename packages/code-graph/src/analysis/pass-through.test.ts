import { describe, expect, it } from "vitest";
import { parseFile } from "@titan-design/code-parser";
import { computeSourceMetrics } from "../source-metrics.js";

const lines = (...ls: string[]): string => `${ls.join("\n")}\n`;

async function passThrough(code: string, lang: "typescript" | "python", name = "f"): Promise<number | undefined> {
  const fp = lang === "python" ? "f.py" : "f.ts";
  const file = await parseFile(code, fp, lang);
  const metrics = computeSourceMetrics([file], (p) => p, new Map([[fp, new Set([name])]]));
  return metrics.find((m) => m.nodeId === `${fp}#${name}` && m.name === "symbol_pass_through")?.value ?? undefined;
}

describe("symbol_pass_through on TypeScript (TP-322)", () => {
  it("flags a function that returns one call forwarding every parameter in order", async () => {
    expect(await passThrough("function f(a: string, b = 1) {\n  return g(a, b);\n}\n", "typescript")).toBe(1);
  });

  it("flags a forwarding arrow with an expression body, a bare parameter and a rest parameter", async () => {
    expect(await passThrough("const f = x => this.g(x);\n", "typescript")).toBe(1);
    expect(await passThrough("const f = (a, ...rest) => g(a, ...rest);\n", "typescript")).toBe(1);
  });

  it("flags a method whose single statement forwards to another object", async () => {
    const code = lines("class K {", "  f(id: string) {", "    this.store.remove(id);", "  }", "}");
    expect(await passThrough(code, "typescript", "K.f")).toBe(1);
  });

  it("does not flag reordered, dropped, extra or transformed arguments", async () => {
    expect(await passThrough("function f(a, b) { return g(b, a); }\n", "typescript")).toBe(0);
    expect(await passThrough("function f(a, b) { return g(a); }\n", "typescript")).toBe(0);
    expect(await passThrough("function f(a) { return g(a, 1); }\n", "typescript")).toBe(0);
    expect(await passThrough("function f(a) { return g(a.id); }\n", "typescript")).toBe(0);
  });

  it("does not flag a function with a second statement, an awaited call, or no parameters", async () => {
    expect(await passThrough("function f(a) { log(a); return g(a); }\n", "typescript")).toBe(0);
    expect(await passThrough("async function f(a) { return await g(a); }\n", "typescript")).toBe(0);
    expect(await passThrough("function f() { return g(); }\n", "typescript")).toBe(0);
  });
});

describe("symbol_pass_through on Python (TP-322)", () => {
  it("flags a decorated method that forwards past its self receiver, defaults allowed", async () => {
    const code = lines(
      "class Repo:",
      "    @property",
      "    def load(self, path, mode='r'):",
      '        """Load a file."""',
      "        return self._reader.read(path, mode)",
    );
    expect(await passThrough(code, "python", "Repo.load")).toBe(1);
  });

  it("flags a bare expression statement and splat forwarding", async () => {
    const code = lines("def f(a, *args, **kwargs):", "    g(a, *args, **kwargs)");
    expect(await passThrough(code, "python")).toBe(1);
  });

  it("flags a typed signature", async () => {
    expect(await passThrough("def f(a: int, b: str = 'x') -> int:\n    return g(a, b)\n", "python")).toBe(1);
  });

  it("does not flag keyword forwarding, a missing parameter or a receiver passed on", async () => {
    expect(await passThrough("def f(a, b):\n    return g(a, b=b)\n", "python")).toBe(0);
    expect(await passThrough("def f(a, b):\n    return g(a)\n", "python")).toBe(0);
    const cls = lines("class C:", "    def f(self, a):", "        return g(self, a)");
    expect(await passThrough(cls, "python", "C.f")).toBe(0);
  });
});
