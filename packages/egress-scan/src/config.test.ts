import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { EMPTY_ALLOW, isAllowed } from "./allow.js";
import { ConfigError, loadAllow, loadTerms } from "./config.js";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "egress-config-"));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

let serial = 0;
function freshDir(): string {
  serial += 1;
  const dir = path.join(scratch, `case-${serial}`);
  fs.mkdirSync(dir);
  return dir;
}

function repoWithAllow(text: string): string {
  const root = freshDir();
  fs.writeFileSync(path.join(root, ".egress-allow"), text);
  return root;
}

function loadError(load: () => unknown): unknown {
  try {
    load();
  } catch (error) {
    return error;
  }
  throw new Error("expected a throw");
}

describe("loadAllow reading the file", () => {
  it("reads a missing file as the empty allow list", () => {
    expect(loadAllow(freshDir())).toBe(EMPTY_ALLOW);
  });

  it("reads a dangling symlink as a missing file", () => {
    const root = freshDir();
    fs.symlinkSync(path.join(root, "gone"), path.join(root, ".egress-allow"));
    expect(loadAllow(root)).toBe(EMPTY_ALLOW);
  });

  it("reads a missing root directory as a missing file", () => {
    expect(loadAllow(path.join(freshDir(), "no-such-root"))).toBe(EMPTY_ALLOW);
  });

  it("fails a directory at the allow path instead of reading it as empty", () => {
    const root = freshDir();
    fs.mkdirSync(path.join(root, ".egress-allow"));
    const error = loadError(() => loadAllow(root));
    expect(error).toBeInstanceOf(ConfigError);
    expect(String(error)).toContain(".egress-allow could not be read");
  });

  it("fails a root that is a file, whose not-a-directory error is not a missing file", () => {
    const file = path.join(freshDir(), "a-file");
    fs.writeFileSync(file, "");
    const error = loadError(() => loadAllow(file));
    expect(error).toBeInstanceOf(ConfigError);
    expect(String(error)).toContain(".egress-allow could not be read");
  });
});

describe("loadAllow parsing the file", () => {
  it.each([
    ["no fields past the glob", "docs/a.md", "line 1: expected <glob> <rule-id> <reason>"],
    ["a rule in the wrong case", "docs/a.md HOME-PATH TP-1", "line 1: unknown rule id"],
    ["a rule with a trailing character", "docs/a.md home-path, TP-1", "line 1: unknown rule id"],
    ["a rule that is an Object.prototype key", "docs/a.md constructor TP-1", "line 1: unknown rule id"],
    ["a rule that is __proto__", "docs/a.md __proto__ TP-1", "line 1: unknown rule id"],
    ["a rule that is an array index", "docs/a.md 0 TP-1", "line 1: unknown rule id"],
    ["a rule that is an array method", "docs/a.md includes TP-1", "line 1: unknown rule id"],
    ["a rule naming two ids", "docs/a.md home-path,aw-data-path TP-1", "line 1: unknown rule id"],
    ["an unknown rule ahead of a missing task id", "docs/a.md nope no task", "line 1: unknown rule id"],
    ["a never-allowable rule ahead of a missing task id", "docs/a.md private-term no task", "line 1: private-term is never allowable"],
    ["a bad reason ahead of a bad glob", "** home-path no task", "line 1: reason must name a task id"],
    ["a bad rule on a later line", "docs/a.md home-path TP-1\r\n\r\ndocs/b.md nope TP-1", "line 3: unknown rule id"],
  ])("fails %s with its line and reason", (_label, text, message) => {
    const error = loadError(() => loadAllow(repoWithAllow(text)));
    expect(error).toBeInstanceOf(ConfigError);
    expect(String(error)).toContain(message);
  });

  it("keeps the exact rule id each entry named and nothing else", () => {
    const allow = loadAllow(repoWithAllow("docs/a.md home-path TP-1\ndocs/b.md aw-data-path TP-2\n"));
    expect(allow.entries.map((entry) => entry.rule)).toEqual(["home-path", "aw-data-path"]);
    expect(Object.keys(allow.entries[0] ?? {}).sort()).toEqual(["glob", "line", "matches", "rule"]);
  });

  it("reads every word past the rule as the reason, so extra fields change no decision", () => {
    const allow = loadAllow(repoWithAllow("docs/a.md home-path TP-1 aw-data-path private-term extra\n"));
    expect(isAllowed(allow, "docs/a.md", "home-path")).toBe(true);
    expect(isAllowed(allow, "docs/a.md", "aw-data-path")).toBe(false);
    expect(isAllowed(allow, "docs/a.md", "private-term")).toBe(false);
  });

  it("reads a comment-only file as no entries", () => {
    expect(loadAllow(repoWithAllow("# docs/a.md home-path TP-1\n\n")).entries).toEqual([]);
  });
});

describe("loadTerms reading the file", () => {
  const termEnv = (file: string, required = "") => ({
    TITAN_EGRESS_TERMS: file,
    TITAN_EGRESS_REQUIRE_TERMS: required,
  });

  it("gives a notice for a missing list", () => {
    const loaded = loadTerms(termEnv(path.join(freshDir(), "gone")));
    expect(loaded).toEqual({ terms: [], loaded: false, notices: ["private term list not found; generic rules only"] });
  });

  it("gives a notice for a dangling symlink, as for a missing list", () => {
    const file = path.join(freshDir(), "link");
    fs.symlinkSync(`${file}-gone`, file);
    expect(loadTerms(termEnv(file)).loaded).toBe(false);
  });

  it("fails a missing list when terms are required", () => {
    const error = loadError(() => loadTerms(termEnv(path.join(freshDir(), "gone"), "1")));
    expect(error).toBeInstanceOf(ConfigError);
    expect(String(error)).toContain("private term list not found and TITAN_EGRESS_REQUIRE_TERMS=1");
  });

  it("fails a directory at the list path instead of reading it as missing", () => {
    const error = loadError(() => loadTerms(termEnv(freshDir())));
    expect(error).toBeInstanceOf(ConfigError);
    expect(String(error)).toContain("private term list could not be read");
  });

  it("fails a path under a file, whose not-a-directory error is not a missing list", () => {
    const file = path.join(freshDir(), "a-file");
    fs.writeFileSync(file, "");
    const error = loadError(() => loadTerms(termEnv(path.join(file, "terms"))));
    expect(error).toBeInstanceOf(ConfigError);
    expect(String(error)).toContain("private term list could not be read");
  });

  it("names the requirement when a required list cannot be read", () => {
    const error = loadError(() => loadTerms(termEnv(freshDir(), "1")));
    expect(error).toBeInstanceOf(ConfigError);
    expect(String(error)).toContain("private term list could not be read and TITAN_EGRESS_REQUIRE_TERMS=1");
  });
});
