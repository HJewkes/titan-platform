import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseMemoryFile, type ParsedFact } from "@titan-design/memory";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { fact } from "./home.fixture.js";
import { buildMemoryReport, writeMemoryReport } from "./report.js";

const NOW = new Date("2026-10-11T06:45:00.123Z");

function parsed(name: string, description: string, body: string, project = "p1"): ParsedFact {
  const result = parseMemoryFile(fact(name, description, body), { account: "default", project, path: `/m/${project}/${name}.md` });
  if (!result.ok) throw new Error(result.error);
  return result;
}

const FACTS = [
  parsed("release-npm", "Pin npm in release jobs", "Pin npm to 11 in release jobs."),
  parsed("release-npm", "Pin npm in release jobs", "Pin npm to 11 in release jobs.", "p2"),
  parsed("release-tags", "Release jobs push npm tags", "Release jobs push tags after npm publish."),
  parsed("lint-zero", "Keep lint warnings at zero", "Zero lint warnings in modified files."),
];

let out: string;

beforeEach(() => {
  out = mkdtempSync(path.join(os.tmpdir(), "titan-memory-report-"));
});

afterEach(() => {
  rmSync(out, { recursive: true, force: true });
});

describe("buildMemoryReport", () => {
  it("gives the same report id for the same facts in any order", () => {
    const forward = buildMemoryReport(FACTS, [], NOW);
    const reversed = buildMemoryReport([...FACTS].reverse(), [], NOW);

    expect(reversed.reportId).toBe(forward.reportId);
    expect(forward.reportId).toMatch(/^20261011T064500Z-[0-9a-f]{8}$/);
  });

  it("keeps every source of a duplicated fact in its group", () => {
    const report = buildMemoryReport(FACTS, [], NOW);

    const release = report.groups.find((group) => group.sources.some((source) => source.project === "p2"));
    expect(release?.sources.map((source) => source.project).sort()).toEqual(["p1", "p1", "p2"]);
  });
});

describe("writeMemoryReport", () => {
  it("writes the report readable by the owner only", () => {
    const written = writeMemoryReport(path.join(out, "memory-miner"), buildMemoryReport(FACTS, [], NOW));

    expect(statSync(written.dir).mode & 0o777).toBe(0o700);
    expect(statSync(written.report).mode & 0o777).toBe(0o600);
    expect(statSync(written.decisions).mode & 0o777).toBe(0o600);
  });

  it("starts every group in decisions.yml as pending, with a destination and hashed sources", () => {
    const written = writeMemoryReport(out, buildMemoryReport(FACTS, [], NOW));

    const decisions = parse(readFileSync(written.decisions, "utf8")) as { groups: { decision: string; destination: string; sources: { contentHash: string }[] }[] };
    expect(decisions.groups.length).toBeGreaterThan(0);
    for (const group of decisions.groups) {
      expect(group.decision).toBe("pending");
      expect(group.destination).not.toBe("");
      expect(group.sources.every((source) => source.contentHash.length > 0)).toBe(true);
    }
  });
});
