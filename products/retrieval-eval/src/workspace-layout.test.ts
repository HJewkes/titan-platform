import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Candidate } from "./candidates/candidate.js";
import { noteAliases } from "./candidates/candidate.js";
import { hybridVector } from "./candidates/hybrid-vector.js";
import { matchRanks } from "./metrics.js";
import { sessionDirs } from "./mine/bootstrap-arm.js";
import { normaliseLabel } from "./mine/labels.js";
import type { EvalPair } from "./pairs.js";
import { corpusLister } from "./served/labels.js";
import { initiativeDir, pathToRef, refToPath } from "./workspace-layout.js";

let root: string;

function write(relative: string, body = "x"): string {
  const file = path.join(root, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body);
  return file;
}

const noLexical: Candidate = { name: "none", search: async () => [], close() {} };

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "retrieval-eval-layout-"));
  write("live/sources/notes/2026-09-01-live.md");
  write("live/sessions/2026-09-01-0900-a.md");
  write("archive/old/sources/notes/2026-01-01-retired.md", "retired archive wiring notes");
  write("archive/old/sources/design.md");
  write("archive/old/sessions/2026-01-01-0900-b.md");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("workspace layout", () => {
  it("resolves a live initiative before an archived one, and neither when absent", () => {
    expect(initiativeDir(root, "live")).toBe(path.join(root, "live"));
    expect(initiativeDir(root, "old")).toBe(path.join(root, "archive", "old"));
    expect(initiativeDir(root, "nope")).toBeUndefined();
  });

  it("maps a ref to a path and back, live and archived alike", () => {
    for (const ref of ["note:live/2026-09-01-live.md", "note:old/2026-01-01-retired.md", "source:old/design.md"]) {
      expect(pathToRef(refToPath(ref, root)!)).toBe(ref);
    }
    expect(refToPath("note:old/2026-01-01-retired.md", root)).toBe("archive/old/sources/notes/2026-01-01-retired.md");
  });

  it("has no path for a task ref, which names no initiative", () => {
    expect(refToPath("task:TP-1", root)).toBeUndefined();
  });

  it("scores an archived note hit from hybrid-fts-vector against the label mined from its path", async () => {
    const label = normaliseLabel(path.join(root, "archive/old/sources/notes/2026-01-01-retired.md"), root);
    const pair: EvalPair = { arm: "spawn", id: "p", query: "q", labels: [label], provenance: {} as EvalPair["provenance"] };
    const candidate = await hybridVector({ activeRoot: root, lexical: noLexical });

    const hits = await candidate.search("retired archive wiring", 1, { arm: "spawn" });

    expect(hits[0]!.id).toBe("note:old/2026-01-01-retired.md");
    expect(matchRanks(hits, pair)).toEqual([1]);
    expect(noteAliases(hits[0]!.id, root)).toContain(label.relative);
  });

  it("lists sessions and corpus files of archived initiatives too", () => {
    expect(sessionDirs(root).map((entry) => entry.initiative)).toEqual(["live", "old"]);
    expect(corpusLister(root)("old", "note")).toEqual(["2026-01-01-retired.md"]);
    expect(corpusLister(root)("old", "source")).toEqual(["design.md"]);
  });
});
