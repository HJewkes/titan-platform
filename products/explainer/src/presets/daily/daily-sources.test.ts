import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadDailySources } from "./daily-sources.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function dataDirWith(sources?: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "daily-sources-"));
  dirs.push(dir);
  if (sources !== undefined) {
    mkdirSync(path.join(dir, "daily"));
    writeFileSync(path.join(dir, "daily", "sources.yaml"), sources);
  }
  return dir;
}

describe("loadDailySources", () => {
  it("reads the repos and the decisions path from a daily-sources/v1 file", () => {
    const dir = dataDirWith("schema: daily-sources/v1\nrepos:\n  - acme/widgets\n  - acme/gears\ndecisions: /notes/decisions.md\n");

    expect(loadDailySources(dir)).toEqual({ repos: ["acme/widgets", "acme/gears"], decisions: "/notes/decisions.md" });
  });

  it("leaves the decisions path out when the file names none", () => {
    const dir = dataDirWith("schema: daily-sources/v1\nrepos:\n  - acme/widgets\n");

    expect(loadDailySources(dir)).toEqual({ repos: ["acme/widgets"] });
  });

  it("refuses a key the schema does not know", () => {
    const dir = dataDirWith("schema: daily-sources/v1\nrepos:\n  - acme/widgets\nrepo: acme/typo\n");

    expect(() => loadDailySources(dir)).toThrow();
  });

  it("refuses a repo that is not owner/name", () => {
    const dir = dataDirWith("schema: daily-sources/v1\nrepos:\n  - widgets\n");

    expect(() => loadDailySources(dir)).toThrow();
  });

  it("is undefined when the data dir keeps no sources file", () => {
    expect(loadDailySources(dataDirWith())).toBeUndefined();
  });
});
