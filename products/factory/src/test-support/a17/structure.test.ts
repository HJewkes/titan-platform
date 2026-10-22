import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NOT_EVENT } from "./not-event.js";
import { scanA17, type A17Scan } from "./structure.js";

const SRC = fileURLToPath(new URL("../..", import.meta.url));
const A17 = "A17:";
const none: A17Scan["notEvent"] = [];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

const readTree = (root: string): Record<string, string> =>
  Object.fromEntries(sourceFiles(root).map((path) => [relative(root, path).split(sep).join("/"), readFileSync(path, "utf8")]));

describe("A17 structure guard on fixtures", () => {
  it("flags an A17 title in a file that imports the event log and skips a17Event", () => {
    const file = `import { appendEvent } from "./event-log/event-log.js";\nit("${A17} x", () => {});\n`;

    expect(scanA17({ "x.test.ts": file }, none).violations).toEqual([{ file: "x.test.ts", title: `${A17} x`, rule: "unregistered-event" }]);
  });

  it("passes the same file when the case goes through a17Event", () => {
    const file = `import { appendEvent } from "./event-log/event-log.js";\na17Event("x", () => {});\n`;

    expect(scanA17({ "x.test.ts": file }, none).violations).toEqual([]);
  });

  it("flags a describe-registered A17 title in an event file", () => {
    const file = `import { x } from "./github-sources/mode.js";\ndescribe("${A17} y", () => {});\n`;

    expect(scanA17({ "y.test.ts": file }, none).violations.map((v) => v.rule)).toEqual(["unregistered-event"]);
  });

  it("does not flag an A17 title in a file with no event import", () => {
    const file = `it("${A17} deploy", () => {});\n`;

    const scan = scanA17({ "deploy.test.ts": file }, none);

    expect(scan.violations).toEqual([]);
    expect(scan.singleMode).toEqual([{ file: "deploy.test.ts", title: `${A17} deploy` }]);
  });

  it("accepts an event file's A17 title that NOT_EVENT lists", () => {
    const file = `import { x } from "./ingress/h.js";\nit("${A17} z", () => {});\n`;

    const scan = scanA17({ "z.test.ts": file }, [{ file: "z.test.ts", title: `${A17} z`, reason: "r" }]);

    expect(scan.violations).toEqual([]);
  });

  it.each(["skip", "todo", "only", "skipIf(true)", "runIf(false)"])("flags it.%s on an A17 title even in a non-event file", (modifier) => {
    const file = `it.${modifier}("${A17} q", () => {});\n`;

    expect(scanA17({ "q.test.ts": file }, none).violations.map((v) => v.rule)).toEqual([`modifier:${modifier.replace(/\(.*/, "")}`]);
  });

  it("does not flag a modifier on a title that is not A17", () => {
    expect(scanA17({ "q.test.ts": `it.skip("other", () => {});\n` }, none).violations).toEqual([]);
  });

  it("reports a NOT_EVENT entry whose file no longer carries its title", () => {
    const scan = scanA17({ "a.test.ts": "" }, [{ file: "a.test.ts", title: `${A17} gone`, reason: "r" }]);

    expect(scan.staleNotEvent).toEqual([{ file: "a.test.ts", title: `${A17} gone`, reason: "r" }]);
  });
});

describe("A17 structure guard on the factory tree", () => {
  const tree = readTree(SRC);

  it("finds no unregistered event case, no skipped case, and no stale NOT_EVENT entry", () => {
    const scan = scanA17(tree, NOT_EVENT);

    expect({ violations: scan.violations, stale: scan.staleNotEvent }).toEqual({ violations: [], stale: [] });
  });

  it("sees the deploy probe cases and finds each in NOT_EVENT", () => {
    const scan = scanA17(tree, NOT_EVENT);
    const files = scan.singleMode.map((entry) => entry.file);

    expect(files).toEqual(expect.arrayContaining(["deploy-ports.test.ts", "deploy-watch-window.test.ts"]));
    for (const entry of scan.singleMode) expect(NOT_EVENT).toContainEqual(expect.objectContaining(entry));
  });

  it("gives every NOT_EVENT entry a reason", () => {
    expect(NOT_EVENT.filter((entry) => entry.reason.trim() === "")).toEqual([]);
  });
});
