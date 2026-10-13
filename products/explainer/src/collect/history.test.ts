import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mineHistory, validateDecisions, type Decision } from "./history.js";

let repo: string;
const shas: Record<string, string> = {};

const git = (...args: string[]): string =>
  execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function commit(label: string, message: string, files: Record<string, string | null>): void {
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(repo, file);
    if (content === null) rmSync(target);
    else {
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
  }
  git("add", "-A");
  git("commit", "-q", "-m", message);
  shas[label] = git("rev-parse", "HEAD");
}

beforeAll(() => {
  repo = mkdtempSync(path.join(tmpdir(), "explainer-history-"));
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Fixture Author");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "commit.gpgsign", "false");
  commit("init", "Add parser skeleton", { "src/parse.ts": "export {};\n", "src/legacy.ts": "export {};\n" });
  commit("feature", "Add token reader\n\nReads tokens from the input stream.", { "src/read.ts": "export {};\n" });
  commit("why", "Cache parsed files by path\n\nKey the cache by path rather than content hash, because hashing\nevery file on each run doubled the cold start.", { "src/cache.ts": "export {};\n" });
  commit("removal", "Fold the legacy importer into the token reader\n\nNo caller has used it since the token reader landed.", { "src/legacy.ts": null });
  commit("rename", "Rename read to readTokens", { "src/read.ts": "export const readTokens = 1;\n" });
  commit("docs", "Fix a typo in the parser comment\n\nSpelling only.", { "src/parse.ts": "// parser\nexport {};\n" });
});

afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe("mineHistory", () => {
  it("picks exactly the removal commit and the why-word commit out of six", () => {
    const { history, decisions } = mineHistory(repo);

    expect(history).toHaveLength(6);
    expect(decisions.map((d) => d.sha).sort()).toEqual([shas.why, shas.removal].sort());
  });

  it("quotes the why sentence verbatim and extracts the road not taken", () => {
    const { decisions } = mineHistory(repo);

    expect(decisions.find((d) => d.sha === shas.why)).toEqual({
      what: "Cache parsed files by path",
      why: "Key the cache by path rather than content hash, because hashing every file on each run doubled the cold start.",
      alternative: "content hash",
      sha: shas.why,
      why_source: "commit",
    });
  });

  it("emits only shas that exist in the clone, and every mined decision passes the gate", () => {
    const { decisions } = mineHistory(repo);

    for (const d of decisions) expect(git("cat-file", "-t", d.sha)).toBe("commit");
    expect(validateDecisions(repo, decisions).rejected).toEqual([]);
  });

  it("flags a commit that deletes a file as a removal though its subject uses no removal verb", () => {
    const { history } = mineHistory(repo);

    expect(history.filter((h) => h.removal).map((h) => h.sha)).toEqual([shas.removal]);
  });

  it("reads a ref that looks like an option as a revision, never as a git flag", () => {
    const planted = path.join(repo, "planted.txt");

    expect(() => mineHistory(repo, `--output=${planted}`)).toThrow();
    expect(existsSync(planted)).toBe(false);
  });
});

describe("validateDecisions", () => {
  const quoted = (): Decision => ({
    what: "Fold the legacy importer into the token reader",
    why: "No caller has used it since the token reader landed.",
    sha: shas.removal ?? "",
    why_source: "commit",
  });

  it("rejects a why that paraphrases the commit instead of quoting it", () => {
    const paraphrase = { ...quoted(), why: "Nobody called the legacy importer anymore." };

    const { accepted, rejected } = validateDecisions(repo, [paraphrase]);

    expect(accepted).toEqual([]);
    expect(rejected[0]?.reason).toMatch(/not quoted verbatim/);
  });

  it("rejects a one-word why even though the message contains it", () => {
    const { rejected } = validateDecisions(repo, [{ ...quoted(), why: "caller" }]);

    expect(rejected[0]?.reason).toMatch(/shorter than 4 words/);
  });

  it("rejects a why quoted from the subject line, which says what changed rather than why", () => {
    const { rejected } = validateDecisions(repo, [{ ...quoted(), why: "Fold the legacy importer" }]);

    expect(rejected[0]?.reason).toMatch(/not quoted verbatim from the body/);
  });

  it("checks a SHA-256 object id against the clone instead of rejecting its shape", () => {
    const { rejected } = validateDecisions(repo, [{ ...quoted(), sha: "a".repeat(64) }]);

    expect(rejected[0]?.reason).toMatch(/not a commit/);
  });

  it("rejects a well-formed sha that is not a commit in the clone", () => {
    const ghost = { ...quoted(), sha: "0".repeat(40) };

    const { rejected } = validateDecisions(repo, [ghost]);

    expect(rejected[0]?.reason).toMatch(/not a commit/);
  });

  it("rejects a decision that does not cite the commit as its why source", () => {
    const { rejected } = validateDecisions(repo, [{ ...quoted(), why_source: "model" }]);

    expect(rejected[0]?.reason).toMatch(/invalid decision/);
  });

  it("accepts a verbatim quote even when the commit wrapped it across lines", () => {
    const wrapped = { ...quoted(), sha: shas.why ?? "", why: "because hashing every file on each run doubled the cold start." };

    expect(validateDecisions(repo, [quoted(), wrapped]).accepted).toHaveLength(2);
  });
});
