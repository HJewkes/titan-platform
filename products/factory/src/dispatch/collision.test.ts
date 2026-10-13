import { describe, expect, it } from "vitest";
import { LANDING_LOG_FORMAT, coveredIds, landingLines, namesId, readPrFiles } from "./collision.js";
import type { Runner } from "./runner.js";

describe("namesId", () => {
  it.each([
    ["Add scorer (TP-400) (#12)", "TP-400", true],
    ["Add scorer (TP-400) (#12)", "TP-40", false],
    ["agent-chat/sa-cc-202-collision-check", "CC-202", true],
    ["agent-chat/sa-cc-2020-thing", "CC-202", false],
    ["XTP-40 is a different prefix", "TP-40", false],
  ])("%s names %s: %s", (text, id, expected) => {
    expect(namesId(text, id)).toBe(expected);
  });
});

describe("coveredIds", () => {
  it.each([
    ["Covers CC-1, CC-2 and CC-3.", ["CC-1", "CC-2", "CC-3"]],
    ["Slice 1 of X. Also covers TP-4 & TP-5.", ["TP-4", "TP-5"]],
    ["- Covers: R-9", ["R-9"]],
    ["Refs: CC-826, #613", []],
    ["Partly covers CC-9", []],
    ["This covers CC-7", []],
  ])("%j gives %j", (body, ids) => {
    expect(coveredIds(body)).toEqual(ids);
  });
});

describe("landingLines", () => {
  it("gives each subject, and a covers line when the body has a Covers clause", () => {
    const log = "Add a (TP-1)\x1fCovers TP-2.\n\x1e\nFix b (TP-3)\x1f\x1e\n";

    expect(landingLines(log)).toEqual(["Add a (TP-1)", "Add a (TP-1) [covers TP-2]", "Fix b (TP-3)"]);
  });

  it("names the git log format it parses", () => {
    expect(LANDING_LOG_FORMAT).toBe("--format=%s%x1f%b%x1e");
  });
});

describe("readPrFiles", () => {
  const ghAnswering =
    (stdout: string, status = 0, calls: string[][] = []): Runner =>
    (bin, args) => {
      calls.push([bin, ...args]);
      return { status, stdout };
    };

  it("asks the REST files endpoint and yields a rename's old path too", () => {
    const calls: string[][] = [];
    const out = '{"filename":"src/a.ts","previous":null}\n{"filename":"src/new.ts","previous":"src/old.ts"}\n';

    expect(readPrFiles("/repo", 7, ghAnswering(out, 0, calls))).toEqual(["src/a.ts", "src/old.ts", "src/new.ts"]);
    expect(calls[0]?.slice(0, 4)).toEqual(["gh", "api", "--paginate", "repos/{owner}/{repo}/pulls/7/files?per_page=100"]);
  });

  it("is unreadable when gh fails or any line does not parse", () => {
    expect(readPrFiles("/repo", 7, ghAnswering("", 1))).toBeUndefined();
    expect(readPrFiles("/repo", 7, ghAnswering('{"filename":"a"}\nnot json\n'))).toBeUndefined();
    expect(readPrFiles("/repo", 7, ghAnswering('{"previous":"a"}\n'))).toBeUndefined();
  });
});
