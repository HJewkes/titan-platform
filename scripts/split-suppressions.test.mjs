import { describe, expect, it } from "vitest";
import { serialized, splitBaseline, violationCount } from "./split-suppressions.mjs";

const rule = (count) => ({ "no-undef": { count } });

describe("splitting a root baseline", () => {
  it("files each entry under its package, unchanged, and keeps the total", () => {
    const baseline = { "packages/a/src/x.ts": rule(2), "products/b/src/y.ts": rule(3), "packages/a/scripts/z.ts": rule(1) };

    const split = splitBaseline(baseline, ["packages/a/", "products/b/"]);

    expect(split.get("packages/a/")).toEqual({ "packages/a/src/x.ts": rule(2), "packages/a/scripts/z.ts": rule(1) });
    expect([...split.values()].reduce((sum, entries) => sum + violationCount(entries), 0)).toBe(violationCount(baseline));
  });

  it("does not confuse a package with one whose name it prefixes", () => {
    const split = splitBaseline({ "packages/agent-lifecycle/src/x.ts": rule(1) }, ["packages/agent/", "packages/agent-lifecycle/"]);

    expect([...split.keys()]).toEqual(["packages/agent-lifecycle/"]);
  });

  it("refuses an entry no package holds, rather than dropping a suppression", () => {
    expect(() => splitBaseline({ "scripts/x.mjs": rule(1) }, ["packages/a/"])).toThrow("no workspace package holds scripts/x.mjs");
  });
});

describe("writing a package baseline", () => {
  it("sorts files and rules, with no trailing newline, as eslint's prune writes them", () => {
    const text = serialized({ b: { z: { count: 1 }, a: { count: 2 } }, a: rule(1) });

    expect(Object.keys(JSON.parse(text))).toEqual(["a", "b"]);
    expect(Object.keys(JSON.parse(text).b)).toEqual(["a", "z"]);
    expect(text.endsWith("}")).toBe(true);
  });
});
