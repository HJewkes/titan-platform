import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fixtureEnv, seedRepo } from "@titan-design/test-kit/git";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { gitHooksEnv, hookScripts } from "./dir.js";
import { gitShimScript } from "./git-shim.js";
import { HOST_PATH, NO_VERIFY, expectSpawned, realGitOn, installExecutable, writeGitHooksForExec } from "./git-shim.fixture.js";
import { ENVIRONMENT_SCRUB, hardenedShebang, hookShell, posixShell } from "./posix-shell.js";

const SCRATCH = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "egress-posix-shell-")));
afterAll(() => fs.rmSync(SCRATCH, { recursive: true, force: true }));

const REAL_GIT = realGitOn(HOST_PATH, path.join(SCRATCH, "none"));
const INPUTS = { missingTermsRefuses: true, home: SCRATCH, path: "/usr/bin:/bin" };
// /bin/sh is bash on macOS and dash on Ubuntu; /bin/bash adds a bash-backed pass wherever sh is not.
const SHELLS = ["/bin/dash", "/bin/sh", "/bin/bash"].filter((shell) => fs.existsSync(shell));
const firstLine = (script: string): string => script.split("\n")[0] ?? "";

describe("posixShell", () => {
  it("names dash when it is an executable file", () => {
    expect(posixShell((file) => file === "/bin/dash")).toBe("/bin/dash");
  });

  it("falls back to /bin/sh when dash is missing, never to nothing", () => {
    expect(posixShell(() => false)).toBe("/bin/sh");
  });

  it("falls back to /bin/sh when the probe throws", () => {
    expect(
      posixShell(() => {
        throw new Error("stat failed");
      }),
    ).toBe("/bin/sh");
  });

  it("treats a directory or a non-executable file at /bin/dash as missing", () => {
    expect(posixShell((file) => file !== "/bin/dash")).toBe("/bin/sh");
  });
});

describe.each(SHELLS.map((shell) => [path.basename(shell), shell]))("hooks written for %s", (_name, shell) => {
  const scripts = (): { prePush: string; chain: string } => {
    const written = hookScripts(INPUTS, { shell: hookShell(shell), shimDirs: [] });
    return { prePush: written.get("pre-push") ?? "", chain: written.get("pre-commit") ?? "" };
  };

  it("names the fixed interpreter on line 1, with -p wherever the interpreter takes it", () => {
    const { prePush, chain } = scripts();
    const hardened = hardenedShebang(shell);

    expect(firstLine(prePush)).toBe(hardened);
    expect(firstLine(chain)).toBe(`#!${shell}`);
    expect(hardened.endsWith(" -p")).toBe(shell !== "/bin/dash");
  });

  it("scrubs SHELLOPTS the same way in the chain hook and pre-push, whatever the interpreter", () => {
    const { prePush, chain } = scripts();

    for (const script of [prePush, chain]) expect(script).toContain(ENVIRONMENT_SCRUB);
  });

  it("looks the repo hook up without env, in a subshell that unsets GIT_CONFIG_COUNT", () => {
    const { chain, prePush } = scripts();

    for (const script of [chain, prePush]) {
      expect(script).not.toContain("env -u");
      expect(script).toContain("own=$(unset GIT_CONFIG_COUNT; git rev-parse --git-path hooks 2>/dev/null)");
    }
  });
});

describe("a chain hook counting the commands it runs from PATH", () => {
  let repo: string;
  let log: string;
  let env: Record<string, string>;

  beforeAll(() => {
    repo = path.join(SCRATCH, "repo");
    fs.mkdirSync(repo);
    execFileSync(REAL_GIT, ["init", "-q", repo], { env: fixtureEnv() });
    const stubs = path.join(SCRATCH, "stubs");
    fs.mkdirSync(stubs);
    log = path.join(SCRATCH, "path-commands.log");
    const realEnv = execFileSync("sh", ["-c", "command -v env"], { encoding: "utf8" }).trim();
    for (const [name, real] of [
      ["git", REAL_GIT],
      ["env", realEnv],
    ] as const) {
      installExecutable(path.join(stubs, name), `#!/bin/sh\necho ${name} >> '${log}'\nexec '${real}' "$@"\n`);
    }
    env = { PATH: `${stubs}:/usr/bin:/bin` };
  });

  it.each(SHELLS)("runs exactly one PATH command, git, under %s", (shell) => {
    const hooks = path.join(SCRATCH, `hooks-${path.basename(shell)}`);
    writeGitHooksForExec(hooks, INPUTS, { shell: hookShell(shell), shimDirs: [] });
    fs.rmSync(log, { force: true });

    const run = expectSpawned(spawnSync(path.join(hooks, "pre-commit"), [], { cwd: repo, env, encoding: "utf8" }), "pre-commit");

    expect(run.status).toBe(0);
    expect(fs.readFileSync(log, "utf8").trim().split("\n")).toEqual(["git"]);
  });

  it("is not steered by ENV or SHELLOPTS in the agent environment", () => {
    const marker = path.join(SCRATCH, "env-ran");
    const envFile = path.join(SCRATCH, "envfile");
    fs.writeFileSync(envFile, `touch '${marker}'\n`);
    const hooks = path.join(SCRATCH, "hooks-hostile");
    writeGitHooksForExec(hooks, INPUTS, { shell: hookShell(), shimDirs: [] });

    const run = expectSpawned(
      spawnSync(path.join(hooks, "pre-commit"), [], {
        cwd: repo,
        env: { ...env, ENV: envFile, BASH_ENV: envFile, SHELLOPTS: "xtrace" },
        encoding: "utf8",
      }),
      "pre-commit",
    );

    expect(run.status).toBe(0);
    expect(fs.existsSync(marker)).toBe(false);
  });
});

describe.each(SHELLS)("the git shim written for %s", (shell) => {
  it("names the fixed interpreter on line 1 and scrubs SHELLOPTS like the hooks", () => {
    const script = gitShimScript(REAL_GIT, SCRATCH, [], "", shell);

    expect(firstLine(script)).toBe(hardenedShebang(shell));
    expect(script).toContain(ENVIRONMENT_SCRUB);
  });

  it("refuses a push that skips verification and fails with its message intact", () => {
    const bin = path.join(SCRATCH, `bin-${path.basename(shell)}`);
    fs.mkdirSync(bin, { recursive: true });
    const shim = path.join(bin, "git");
    installExecutable(shim, gitShimScript(REAL_GIT, SCRATCH, [], "", shell));

    const run = spawnSync(shim, ["push", NO_VERIFY], { cwd: SCRATCH, encoding: "utf8" });

    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("git-shim: push refused (no-verify)");
  });
});

describe.each(SHELLS)("a commit through the git shim on %s under a hostile SHELLOPTS", (shell) => {
  it.each(["#!/bin/sh", "#!/bin/bash"])("still runs a refusing %s repo pre-commit hook", (shebang) => {
    const root = fs.mkdtempSync(path.join(SCRATCH, "commit-"));
    const repo = path.join(root, "repo");
    const guard = path.join(root, "git-hooks");
    const marker = path.join(root, "hook-ran");
    const shim = path.join(root, "git");
    const clean = { ...fixtureEnv(), PATH: HOST_PATH, HOME: root };
    seedRepo(repo);
    fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
    execFileSync(REAL_GIT, ["add", "a.txt"], { cwd: repo, env: clean });
    installExecutable(path.join(repo, ".git", "hooks", "pre-commit"), `${shebang}\necho ran >> '${marker}'\nexit 1\n`);
    writeGitHooksForExec(guard, INPUTS, { shell: hookShell(shell), shimDirs: [] });
    installExecutable(shim, gitShimScript(REAL_GIT, guard, [], "", shell));

    const run = spawnSync(shim, ["commit", "-q", "-m", "x"], {
      cwd: repo,
      env: { ...clean, ...gitHooksEnv(guard), SHELLOPTS: "noexec", BASH_VERSION: "5.2.0" },
      encoding: "utf8",
    });

    expect(fs.existsSync(marker)).toBe(true);
    expect(run.status).not.toBe(0);
  });
});
