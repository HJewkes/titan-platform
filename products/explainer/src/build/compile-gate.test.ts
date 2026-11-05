import { describe, expect, it } from "vitest";
import { compileLayer } from "./compile-gate.js";

// Synthetic layers: invented markup, no real module.
describe("compileLayer", () => {
  it("passes a TSX layer that imports only React and the react-ui motion primitives", async () => {
    const module = `import { useCue } from "@titan-design/react-ui/motion";\nimport { useMemo } from "react";\nexport default function Layer() {\n  const shown = useCue("desk");\n  return <div id="desk-card">{useMemo(() => String(shown), [shown])}</div>;\n}\n`;

    const verdict = await compileLayer(module);

    expect(verdict).toEqual({ ok: true });
  });

  it("fails a layer that does not compile, with esbuild's error and its location", async () => {
    const verdict = await compileLayer(`export default function Layer() {\n  return <div>;\n}\n`);

    expect(verdict.ok).toBe(false);
    expect(!verdict.ok && verdict.error).toMatch(/^layer\.tsx:\d+:\d+: .*/);
  });

  it("refuses a static import outside the allowlist", async () => {
    const verdict = await compileLayer(`import { readFileSync } from "node:fs";\nexport const Layer = () => readFileSync("x");\n`);

    expect(verdict.ok).toBe(false);
    expect(!verdict.ok && verdict.error).toContain(`import "node:fs" is not allowed in a custom layer`);
  });

  it("refuses a dynamic import and a require outside the allowlist", async () => {
    const dynamic = await compileLayer(`export const load = () => import("node:child_process");\n`);
    const required = await compileLayer(`const fs = require("fs");\nexport const Layer = () => fs;\n`);

    expect(!dynamic.ok && dynamic.error).toContain(`import "node:child_process" is not allowed`);
    expect(!required.ok && required.error).toContain(`import "fs" is not allowed`);
  });

  it("refuses a react-ui entry point other than motion", async () => {
    const verdict = await compileLayer(`import { Button } from "@titan-design/react-ui";\nexport const Layer = () => Button;\n`);

    expect(!verdict.ok && verdict.error).toContain(`import "@titan-design/react-ui" is not allowed`);
  });
});
