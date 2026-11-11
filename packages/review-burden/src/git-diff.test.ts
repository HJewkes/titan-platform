import { describe, expect, it } from "vitest";
import { changedFiles, parseNameStatus } from "./git-diff.js";

describe("changedFiles", () => {
  it("maps A, R and C name-status letters onto numstat files", () => {
    const numstat = "3\t0\tsrc/new.ts\0" + "1\t1\t\0src/a.ts\0src/b.ts\0" + "4\t0\tsrc/copy.ts\0";
    const nameStatus = "A\0src/new.ts\0R090\0src/a.ts\0src/b.ts\0C075\0src/orig.ts\0src/copy.ts\0";
    const files = changedFiles(numstat, nameStatus).map(({ path, status, previousPath }) => ({ path, status, previousPath }));
    expect(files).toEqual([
      { path: "src/new.ts", status: "added", previousPath: undefined },
      { path: "src/b.ts", status: "renamed", previousPath: "src/a.ts" },
      { path: "src/copy.ts", status: "copied", previousPath: "src/orig.ts" },
    ]);
  });

  it("keeps numstat's guess for a path name-status does not list", () => {
    expect(changedFiles("2\t0\tsrc/x.ts\0", "")).toEqual([{ path: "src/x.ts", status: "modified", additions: 2, deletions: 0 }]);
  });
});

describe("parseNameStatus", () => {
  it("reads a name-status path containing a tab and non-ASCII", () => {
    expect([...parseNameStatus("M\0src/é\tx.ts\0").keys()]).toEqual(["src/é\tx.ts"]);
  });
});
