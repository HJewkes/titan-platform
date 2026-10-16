import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { gitEnv, mineHistory, validateDecisions, type Decision } from "./history.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<{ execFileSync: typeof execFileSync }>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});

let repo: string;
const shas: Record<string, string> = {};
const scratch: string[] = [];

const gitAt = (dir: string, ...args: string[]): string =>
  execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const git = (...args: string[]): string => gitAt(repo, ...args);

function writeFiles(dir: string, files: Record<string, string | null>): void {
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(dir, file);
    if (content === null) rmSync(target);
    else {
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
  }
}

function commitAt(dir: string, message: string, files: Record<string, string | null>): string {
  writeFiles(dir, files);
  gitAt(dir, "add", "-A");
  gitAt(dir, "commit", "-q", "-m", message);
  return gitAt(dir, "rev-parse", "HEAD");
}

function commit(label: string, message: string, files: Record<string, string | null>): void {
  shas[label] = commitAt(repo, message, files);
}

function newRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "explainer-history-"));
  scratch.push(dir);
  gitAt(dir, "init", "-q", "-b", "main");
  gitAt(dir, "config", "user.name", "Fixture Author");
  gitAt(dir, "config", "user.email", "fixture@example.invalid");
  gitAt(dir, "config", "commit.gpgsign", "false");
  return dir;
}

beforeAll(() => {
  repo = newRepo();
  commit("init", "Add parser skeleton", { "src/parse.ts": "export {};\n", "src/legacy.ts": "export {};\n" });
  commit("feature", "Add token reader\n\nReads tokens from the input stream.", { "src/read.ts": "export {};\n" });
  commit("why", "Cache parsed files by path\n\nKey the cache by path rather than content hash, because hashing\nevery file on each run doubled the cold start.", { "src/cache.ts": "export {};\n" });
  commit("removal", "Fold the legacy importer into the token reader\n\nNo caller has used it since the token reader landed.", { "src/legacy.ts": null });
  commit("rename", "Rename read to readTokens", { "src/read.ts": "export const readTokens = 1;\n" });
  commit("docs", "Fix a typo in the parser comment\n\nSpelling only.", { "src/parse.ts": "// parser\nexport {};\n" });
});

afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

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

  it("reads an option-looking ref that names a real branch as that branch in every log call", () => {
    const ref = "--output=planted.txt";
    git("update-ref", `refs/heads/${ref}`, "HEAD");
    try {
      const { history } = mineHistory(repo, ref);

      expect(history).toHaveLength(6);
      expect(existsSync(path.join(repo, "planted.txt"))).toBe(false);
    } finally {
      git("update-ref", "-d", `refs/heads/${ref}`);
    }
  });

  it("marks full history complete", () => {
    expect(mineHistory(repo).complete).toBe(true);
  });

  it("marks a shallow clone's history incomplete", () => {
    const shallow = path.join(newRepo(), "clone");
    execFileSync("git", ["clone", "-q", "--depth", "2", `file://${repo}`, shallow], { stdio: "ignore" });

    const { history, complete } = mineHistory(shallow);

    expect(history).toHaveLength(2);
    expect(complete).toBe(false);
  });
});

describe("mineHistory against a hostile clone", () => {
  afterEach(() => {
    vi.mocked(execFileSync).mockClear();
    delete process.env.GIT_DIR;
    delete process.env.GIT_ALLOW_PROTOCOL;
  });

  it("keeps record separators in a commit body as body text, never as a forged record", () => {
    const dir = newRepo();
    const real = commitAt(dir, "Add the real reader", { "a.ts": "export {};\n" });
    const forged = `\x1e${real}\x1f2020-01-01T00:00:00Z\x1fForged subject\x1fForged because the attacker wants it to look real.\n`;
    const carrier = commitAt(dir, `Tidy the reader\n\nWording only.${forged}`, { "a.ts": "// a\nexport {};\n" });

    const { history, decisions } = mineHistory(dir);

    expect(history.map((h) => [h.sha, h.subject])).toEqual([
      [carrier, "Tidy the reader"],
      [real, "Add the real reader"],
    ]);
    expect(decisions.filter((d) => d.what === "Forged subject")).toEqual([]);
  });

  it.each([
    ["a malformed sha", () => "f".repeat(39)],
    ["a repeated sha", (sha: string) => sha],
  ])("fails closed on log output carrying %s", (_label, second) => {
    const sha = shas.why ?? "";
    const record = (id: string) => `${id}\x002020-01-01T00:00:00Z\0Subject\0Body\n\0`;
    vi.mocked(execFileSync)
      .mockImplementationOnce(() => `${sha}\n`)
      .mockImplementationOnce(() => record(sha) + record(second(sha)));

    expect(() => mineHistory(repo)).toThrow(/sha/);
  });

  it("fails closed when git hangs instead of blocking the caller", () => {
    const dir = newRepo();
    const why = "Read lazily because eager reads stalled the start.";
    const sha = commitAt(dir, `Add the reader\n\n${why}`, { "a.ts": "export {};\n" });
    const decision = { what: "Add the reader", why, sha, why_source: "commit" };
    expect(validateDecisions(dir, [decision]).accepted).toHaveLength(1);
    execFileSync("mkfifo", [path.join(dir, ".git", "shallow")]);

    expect(() => mineHistory(dir, "HEAD", { timeoutMs: 500 })).toThrow();
    expect(validateDecisions(dir, [decision], { timeoutMs: 500 }).accepted).toEqual([]);
  });

  it("never runs a signature program the clone's own config names", () => {
    const dir = newRepo();
    commitAt(dir, "Add the reader", { "a.ts": "export {};\n" });
    const marker = path.join(dir, "gpg-ran");
    const program = path.join(dir, "fake-gpg");
    writeFileSync(program, `#!/bin/sh\ntouch "${marker}"\n`);
    chmodSync(program, 0o755);
    const header = `tree ${gitAt(dir, "rev-parse", "HEAD^{tree}")}\nparent ${gitAt(dir, "rev-parse", "HEAD")}\n`;
    const person = "Fixture Author <fixture@example.invalid> 1700000000 +0000";
    const signed = `${header}author ${person}\ncommitter ${person}\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n synthetic\n -----END PGP SIGNATURE-----\n\nSign the reader\n`;
    const sha = execFileSync("git", ["-C", dir, "hash-object", "-t", "commit", "-w", "--stdin"], { input: signed, encoding: "utf8" }).trim();
    gitAt(dir, "update-ref", "refs/heads/main", sha);
    gitAt(dir, "config", "log.showSignature", "true");
    gitAt(dir, "config", "gpg.program", program);

    const { history } = mineHistory(dir);

    expect(existsSync(marker)).toBe(false);
    expect(history.map((h) => h.subject)).toEqual(["Sign the reader", "Add the reader"]);
  });

  it.each([
    ["only a remote and ssh command", {}],
    ["protocol.ssh.allow=always overriding the protocol pin", { "protocol.ssh.allow": "always" }],
  ])("fails closed in a treeless partial clone whose config sets %s, without running its ssh command", (_label, extra: Record<string, string>) => {
    const source = newRepo();
    gitAt(source, "config", "uploadpack.allowFilter", "true");
    commitAt(source, "Add the reader", { "a.ts": "export {};\n", "b.ts": "export {};\n" });
    commitAt(source, "Drop the second reader", { "b.ts": null });
    const clone = path.join(newRepo(), "treeless");
    execFileSync("git", ["clone", "-q", "--filter=tree:0", `file://${source}`, clone], { stdio: "ignore" });
    const marker = path.join(clone, "ssh-ran");
    const program = path.join(clone, "fake-ssh");
    writeFileSync(program, `#!/bin/sh\ntouch "${marker}"\nexit 1\n`);
    chmodSync(program, 0o755);
    gitAt(clone, "config", "remote.origin.url", "ssh://fixture.invalid/reader.git");
    gitAt(clone, "config", "core.sshCommand", program);
    for (const [key, value] of Object.entries(extra)) gitAt(clone, "config", key, value);

    expect(() => mineHistory(clone)).toThrow();
    expect(existsSync(marker)).toBe(false);
  });

  it("gives git an empty protocol allow-list and no lazy fetch even when the parent allows ssh", () => {
    process.env.GIT_ALLOW_PROTOCOL = "ssh";

    const env = gitEnv();

    expect(env.GIT_ALLOW_PROTOCOL).toBe("");
    expect(env.GIT_NO_LAZY_FETCH).toBe("1");
  });

  it("mines the directory it was given even when GIT_DIR points elsewhere", () => {
    const decoy = newRepo();
    commitAt(decoy, "Decoy commit", { "d.ts": "export {};\n" });
    process.env.GIT_DIR = path.join(decoy, ".git");

    const { history } = mineHistory(repo);

    expect(history.map((h) => h.sha)).toContain(shas.why);
    expect(history.map((h) => h.subject)).not.toContain("Decoy commit");
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

  it("rejects a what that is not the cited commit's subject", () => {
    const { rejected } = validateDecisions(repo, [{ ...quoted(), what: "Rewrite the importer in a faster language" }]);

    expect(rejected[0]?.reason).toMatch(/what is not the subject/);
  });

  it("rejects an alternative the why never mentions", () => {
    const [mined] = mineHistory(repo).decisions.filter((d) => d.sha === shas.why);

    const { rejected } = validateDecisions(repo, [{ ...mined, alternative: "a distributed cache" }]);

    expect(rejected[0]?.reason).toMatch(/alternative is not quoted/);
  });

  it("rejects a decision that does not cite the commit as its why source", () => {
    const { rejected } = validateDecisions(repo, [{ ...quoted(), why_source: "model" }]);

    expect(rejected[0]?.reason).toMatch(/invalid decision/);
  });

  it("accepts a verbatim quote even when the commit wrapped it across lines", () => {
    const wrapped = { ...quoted(), what: "Cache parsed files by path", sha: shas.why ?? "", why: "because hashing every file on each run doubled the cold start." };

    expect(validateDecisions(repo, [quoted(), wrapped]).accepted).toHaveLength(2);
  });
});
