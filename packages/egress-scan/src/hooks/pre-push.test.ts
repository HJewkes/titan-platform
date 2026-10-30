import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fixtureEnv, gitIn, seedRepoWithOrigin } from "@titan-design/test-kit/git";
import { afterAll, describe, expect, it } from "vitest";
import { gitHooksEnv, noRewriteHooksDir, writeGitHooks } from "./dir.js";
import { termsFileFor, type HookShell } from "./pre-push.js";

const SCRATCH = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "egress-hooks-push-")));
afterAll(() => fs.rmSync(SCRATCH, { recursive: true, force: true }));

const SHELL: HookShell = { path: "/bin/sh", shebang: "#!/bin/sh", scrub: "command unset SHELLOPTS 2>/dev/null\n" };
const REAL_GIT = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
const BUILT_SCANNER = fileURLToPath(new URL("../../dist/bin.js", import.meta.url));

// Finds nothing, so only the no-rewrite policy decides.
const CLEAN_SCANNER = `[ "$1" = --help ] && { echo 'pre-push <remote>; files are scanned as text'; exit 0; }
cat >/dev/null
exit 0`;

const REAL_SCANNER = `exec node ${JSON.stringify(BUILT_SCANNER)} "$@"`;

interface Fixture {
  root: string;
  work: string;
  origin: string;
  owner: string;
  /** Runs git in the work repo as the agent would, with git pointed at the written hooks dir. */
  git: (...args: string[]) => { code: number; stderr: string };
}

interface FixtureOptions {
  noRewrite?: boolean;
  scanner?: string;
  terms?: string;
  missingTermsRefuses?: boolean;
}

function scanPath(root: string, scanner: string): string {
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  fs.symlinkSync(process.execPath, path.join(bin, "node"));
  fs.symlinkSync(REAL_GIT, path.join(bin, "git"));
  fs.writeFileSync(path.join(bin, "titan-egress-scan"), `#!/bin/sh\n${scanner}\n`, { mode: 0o755 });
  return `${bin}:/usr/bin:/bin`;
}

function commit(work: string, branch: string, file: string, text = `${file}\n`): void {
  const git = gitIn(work);
  git("checkout", "-q", "-B", branch);
  fs.writeFileSync(path.join(work, file), text);
  git("add", file);
  git("commit", "-q", "-m", `add ${file}`);
}

/** main and feat/x on the origin, the work repo on feat/x, and git pointed at the written hooks dir. */
function fixture({ noRewrite = true, scanner = CLEAN_SCANNER, terms = "zq7leakterm\n", missingTermsRefuses = true }: FixtureOptions = {}): Fixture {
  const root = fs.mkdtempSync(path.join(SCRATCH, "repo-"));
  const work = path.join(root, "work");
  const origin = path.join(root, "origin.git");
  const owner = path.join(root, "owner");
  seedRepoWithOrigin(work, origin);
  commit(work, "feat/x", "x.md");
  gitIn(work)("push", "-q", "origin", "feat/x");
  if (terms !== "") {
    fs.mkdirSync(path.dirname(termsFileFor(owner)), { recursive: true });
    fs.writeFileSync(termsFileFor(owner), terms, { mode: 0o600 });
  }
  const shared = path.join(root, "chat", "git-hooks");
  const hooks = noRewrite ? noRewriteHooksDir(shared) : shared;
  writeGitHooks(hooks, { missingTermsRefuses, home: owner, path: scanPath(root, scanner) }, { shell: SHELL, shimDirs: [] });
  const env = { ...fixtureEnv(), ...gitHooksEnv(hooks) };
  const git = (...args: string[]) => {
    const out = spawnSync("git", args, { cwd: work, env, encoding: "utf8" });
    return { code: out.status ?? -1, stderr: out.stderr };
  };
  return { root, work, origin, owner, git };
}

const originRefs = (f: Fixture): string => gitIn(f.origin)("for-each-ref", "--format=%(refname) %(objectname)");

/** feat/x rebuilt from main, so pushing it is not a fast-forward of the origin's feat/x. */
function rewriteFeatX(f: Fixture): void {
  gitIn(f.work)("checkout", "-q", "main");
  commit(f.work, "feat/x", "rewritten.md");
}

const POLICY = /push refused by the no-rewrite push policy \(CC-1633\)/;

describe("pre-push under the no-rewrite policy", () => {
  it("refuses a forced push that is not a fast-forward, leaving the origin as it was", () => {
    const f = fixture();
    rewriteFeatX(f);
    const before = originRefs(f);

    const result = f.git("push", "--force", "origin", "feat/x");

    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(POLICY);
    expect(result.stderr).toMatch(/refs\/heads\/feat\/x is not a fast-forward of the remote's tip/);
    expect(originRefs(f)).toBe(before);
  });

  it.each([
    ["a delete", ["push", "origin", "--delete", "feat/x"], /it deletes refs\/heads\/feat\/x/],
    ["an update of main", ["push", "origin", "HEAD:refs/heads/main"], /it updates refs\/heads\/main/],
    ["a ref outside heads and tags", ["push", "origin", "HEAD:refs/notes/x"], /refs\/notes\/x is outside refs\/heads\/ and refs\/tags\//],
    ["a push to a mirror remote, which would prune feat/x", ["-c", "remote.origin.mirror=true", "push", "origin"], /remote origin is a mirror/],
  ])("refuses %s", (_name, args, why) => {
    const f = fixture();
    const before = originRefs(f);
    gitIn(f.work)("checkout", "-q", "--detach");
    gitIn(f.work)("branch", "-D", "feat/x");

    const result = f.git(...args);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(POLICY);
    expect(result.stderr).toMatch(why);
    expect(originRefs(f)).toBe(before);
  });

  it("lets a fast-forward and a new branch through", () => {
    const f = fixture();
    commit(f.work, "feat/x", "more.md");
    commit(f.work, "feat/y", "y.md");

    const result = f.git("push", "origin", "feat/x", "feat/y");

    expect(result.code).toBe(0);
    expect(gitIn(f.origin)("rev-parse", "feat/x", "feat/y")).toBe(gitIn(f.work)("rev-parse", "feat/x", "feat/y"));
  });

  it("leaves a default-dir push to the scan alone, so a delete goes through", () => {
    const f = fixture({ noRewrite: false });

    const result = f.git("push", "origin", "--delete", "feat/x");

    expect(result.code).toBe(0);
    expect(gitIn(f.origin)("for-each-ref", "refs/heads/feat")).toBe("");
  });
});

describe("pre-push scan with the built titan-egress-scan", () => {
  it("refuses a push when the private term list is missing", () => {
    const f = fixture({ scanner: REAL_SCANNER, terms: "" });
    commit(f.work, "feat/x", "more.md");
    const before = originRefs(f);

    const result = f.git("push", "origin", "feat/x");

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(`leak-scan: push refused: no private term list at ${termsFileFor(f.owner)}`);
    expect(originRefs(f)).toBe(before);
  });

  it("warns and lets the push through on generic rules when a missing list is allowed", () => {
    const f = fixture({ scanner: REAL_SCANNER, terms: "", missingTermsRefuses: false });
    commit(f.work, "feat/x", "more.md");

    const result = f.git("push", "origin", "feat/x");

    expect(result.code).toBe(0);
    expect(result.stderr).toContain("leak-scan: WARNING: no private term list at");
  });

  it("refuses a push whose commits add a private term, pointing at the allow list", () => {
    const f = fixture({ scanner: REAL_SCANNER });
    commit(f.work, "feat/x", "notes.md", "mentions zq7leakterm here\n");
    const before = originRefs(f);

    const result = f.git("push", "origin", "feat/x");

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("only .egress-allow entries already on the remote's default branch count");
    expect(result.stderr).not.toContain("zq7leakterm");
    expect(originRefs(f)).toBe(before);
  });

  it("lets a clean push through", () => {
    const f = fixture({ scanner: REAL_SCANNER });
    commit(f.work, "feat/x", "more.md");

    const result = f.git("push", "origin", "feat/x");

    expect(result.code).toBe(0);
    expect(gitIn(f.origin)("rev-parse", "feat/x")).toBe(gitIn(f.work)("rev-parse", "feat/x"));
  });
});

describe("pre-push chaining", () => {
  it("runs the repo's own pre-push hook after a passing scan, and its refusal refuses the push", () => {
    const f = fixture({ noRewrite: false });
    fs.writeFileSync(path.join(f.work, ".git", "hooks", "pre-push"), "#!/bin/sh\necho own-hook-ran >&2\nexit 7\n", { mode: 0o755 });
    commit(f.work, "feat/x", "more.md");

    const result = f.git("push", "origin", "feat/x");

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("own-hook-ran");
  });

  it("warns that the push was not scanned when no scanner is on the baked PATH", () => {
    const f = fixture({ noRewrite: false, scanner: "exit 0" });
    fs.rmSync(path.join(f.root, "bin", "titan-egress-scan"));
    commit(f.work, "feat/x", "more.md");

    const result = f.git("push", "origin", "feat/x");

    expect(result.code).toBe(0);
    expect(result.stderr).toContain("leak-scan: guard NOT run, this push was not scanned: no titan-egress-scan");
  });
});
