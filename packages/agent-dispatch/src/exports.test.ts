import { describe, expect, it } from "vitest";

const subpaths = [
  "profiles",
  "profiles/node",
  "launch",
  "brief",
  "host",
  "roster",
  "gates",
  "isolation",
];

describe("package subpaths", () => {
  it.each(subpaths)("resolves %s through the exports map", async (subpath) => {
    const mod = await import(`@titan-design/agent-dispatch/${subpath}`);
    expect(mod).toBeTypeOf("object");
  });
});
