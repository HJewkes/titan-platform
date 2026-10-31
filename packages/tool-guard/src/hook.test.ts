import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { linearRegExpSteps } from "@titan-design/fix-proof/linear-regexp";
import { afterEach, describe, expect, it } from "vitest";
import { nodeContext } from "./context.js";
import type { ReadFs } from "./context.js";
import { decide } from "./decide.js";
import { handle, MAX_COMMAND_BYTES, namesGuarded } from "./hook.js";
import type { HookPort, HookResult } from "./hook.js";
import { UnreadableScriptError } from "./shell/unsure-readings.js";
import { countWork, expectLinearWork } from "./test-support/work-count.js";
import type { ClassifyContext } from "./types.js";

const HOME = "/home/you";
const REPO = "/home/you/projects/app";
const ts = new Date("2026-01-02T03:04:05.000Z");

/** Nothing exists on this filesystem unless listed; `links` maps a path to its realpath. */
function fakeFs(links: Record<string, string> = {}): ReadFs {
  return {
    realpath: (p) => {
      const real = links[p];
      if (real === undefined) throw new Error("ENOENT");
      return real;
    },
    readHead: () => {
      throw new Error("ENOENT");
    },
    isFile: () => false,
  };
}

/** The owner bypass this variable once turned on is retired: an agent can set it for any process it starts. */
const RETIRED_BYPASS = { TITAN_TOOL_GUARD_BYPASS: "1" };
/** Refusing an oversize command unread reads 274 characters of it; classifying it would read all 40 000. */
const UNREAD_WORK = 1_000;

function port(overrides: Partial<HookPort> = {}): HookPort {
  return { context: nodeContext(HOME, fakeFs()), now: () => ts, loadDecide: async () => decide, ...overrides };
}

function bash(command: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ tool_name: "Bash", session_id: "sess-1", tool_use_id: "tu-1", cwd: REPO, tool_input: { command }, ...extra });
}

function read(filePath: string): string {
  return JSON.stringify({ tool_name: "Read", session_id: "sess-1", cwd: REPO, tool_input: { file_path: filePath } });
}

function decisionOf(stdout: string): string | null {
  if (stdout === "") return null;
  return (JSON.parse(stdout) as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput.permissionDecision;
}

describe("handle: the credential read", () => {
  it("denies the Read path and the Bash path of the same token file", async () => {
    const viaRead = await handle(read(`${HOME}/.agent-chat/ui.token`), {}, port());
    const viaBash = await handle(bash("cat ~/.agent-chat/ui.token"), {}, port());

    expect(decisionOf(viaRead.stdout)).toBe("deny");
    expect(decisionOf(viaBash.stdout)).toBe("deny");
    expect(viaRead.log).toHaveLength(1);
    expect(viaBash.log).toHaveLength(1);
  });

  it("prints the PreToolUse deny answer with a one-line reason", async () => {
    const { stdout } = await handle(bash("cat ~/.npmrc"), {}, port());

    expect(JSON.parse(stdout)).toEqual({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: expect.stringMatching(/^authority-guard denied secret-read .*owner/) },
    });
    expect(stdout).not.toContain("\n");
  });

  it("denies a case variant that a case-insensitive filesystem opens as the guarded file", async () => {
    const context = nodeContext(HOME, fakeFs({ [`${HOME}/.NPMRC`]: `${HOME}/.npmrc` }));

    const { stdout } = await handle(bash("cat ~/.NPMRC"), {}, port({ context }));

    expect(decisionOf(stdout)).toBe("deny");
  });
});

describe("handle: the deny log line", () => {
  it("holds only the fixed fields: no command text, no token from it, no env value", async () => {
    const token = "zq" + "Ab12Cd34Ef56Gh78Ij90Kl12Mn34";
    const command = `cat ~/.npmrc; echo ${token}`;
    const env = { AGENT_CHAT_AGENT_ID: "impl-7", OTHER_VALUE: "zq-env-" + "value-planted" };

    const { log } = await handle(bash(command), env, port());

    expect(log).toHaveLength(1);
    const fields = (log[0] as string).split("\t");
    expect(fields).toEqual(["2026-01-02T03:04:05.000Z", "deny", "SEC-CO", "secret-read", "bash.secret.cat", "coordinator+worker+headless", "impl-7", "sess-1", "Bash", "tu-1", "pattern=home:.npmrc"]);
    expect(log[0]).not.toContain(command);
    expect(log[0]).not.toContain(token);
    expect(log[0]).not.toContain(env.OTHER_VALUE);
    expect(log[0]).not.toContain(REPO);
  });
});

describe("handle: failure policy", () => {
  it("passes non-JSON stdin and logs one shape error without the input", async () => {
    const raw = "not json zq-raw-" + "input";

    const result = await handle(raw, {}, port());

    expect(result.stdout).toBe("");
    expect(result.log).toEqual(["2026-01-02T03:04:05.000Z\terror\tshape\t-\t-"]);
  });

  it("passes a known tool with the wrong input shape and logs the tool name", async () => {
    const result = await handle(JSON.stringify({ tool_name: "Read", tool_input: { path: "x" } }), {}, port());

    expect(result).toEqual({ stdout: "", log: ["2026-01-02T03:04:05.000Z\terror\tshape\tRead\t-"] });
  });

  it("stays silent for a tool it does not guard", async () => {
    expect(await handle(JSON.stringify({ tool_name: "WebFetch", tool_input: { url: "x" } }), {}, port())).toEqual({ stdout: "", log: [] });
  });

  it("denies an unparseable command whether or not it names a guarded path", async () => {
    const guarded = await handle(bash("cat ~/.npmrc 'x"), {}, port());
    const plain = await handle(bash("echo 'x"), {}, port());

    expect([guarded, plain].map((r) => decisionOf(r.stdout))).toEqual(["deny", "deny"]);
    expect(plain.log[0]?.split("\t").slice(1, 5)).toEqual(["deny", "none", "unparsed", "bash.unparsed"]);
  });

  it("denies a protected push that a chain of dynamic wrapper words follows", async () => {
    const result = await handle(bash(`git push origin HEAD:main; ${"timeout $T 5 ".repeat(9)}true`), {}, port());

    expect(decisionOf(result.stdout)).toBe("deny");
    expect(result.log[0]?.split("\t").slice(4, 5)).toEqual(["bash.merge.git-push-protected"]);
  });

  it("denies a protected push behind a chain of dynamic wrapper words", async () => {
    const result = await handle(bash(`${"sudo $a ".repeat(9)}git push origin HEAD:main`), {}, port());

    expect(decisionOf(result.stdout)).toBe("deny");
  });

  it("denies a command with more dynamic wrapper readings than it checks, and says to split it", async () => {
    const result = await handle(bash(`${"sudo $a ".repeat(400)}git push origin HEAD:feat/x`), {}, port());

    expect(decisionOf(result.stdout)).toBe("deny");
    expect(result.stdout).toMatch(/variables in wrapper positions/);
    expect(result.log[0]?.split("\t").slice(1, 5)).toEqual(["deny", "none", "oversize", "bash.oversize"]);
  });

  it.each([
    ["first", `git push origin HEAD:main; ${"sudo $a ".repeat(600)}true`],
    ["last", `${"sudo $a ".repeat(600)}true; git push origin HEAD:main`],
  ])("denies a script past the reading budget that xargs runs, with the push %s", async (_where, script) => {
    const context = { ...nodeContext(HOME, fakeFs()), readScript: (p: string) => (p === `${REPO}/pad1.sh` ? script : null) };

    const result = await handle(bash("printf 'pad1.sh\\n' | xargs -J % bash %"), {}, port({ context }));

    expect(decisionOf(result.stdout)).toBe("deny");
  });

  const PUSH = "git push origin HEAD:main\n";
  const PAD = "echo hi; ".repeat(7000);
  it.each([
    ["timeout $P . a.sh", "first", PUSH + PAD],
    ["timeout $P . a.sh", "last", PAD + PUSH],
    ["timeout $P source a.sh", "first", PUSH + PAD],
    ["timeout $P source a.sh", "last", PAD + PUSH],
    ["timeout $P bash a.sh", "first", PUSH + PAD],
    ["timeout $P bash a.sh", "last", PAD + PUSH],
  ])("denies `%s` running a 63 KB script with the push %s, case folding on", async (line, _where, script) => {
    const context = { ...nodeContext(HOME, fakeFs()), foldCase: true, readScript: (p: string) => (p === `${REPO}/a.sh` ? script : null) };

    const result = await handle(bash(line), {}, port({ context }));

    expect(decisionOf(result.stdout)).toBe("deny");
    expect(result.log[0]?.split("\t").slice(4, 5)).toEqual(["bash.merge.git-push-protected"]);
  }, 30_000);

  const pads = (...names: string[]) => {
    const readScript = (p: string) => (names.some((n) => p === `${REPO}/${n}`) ? PAD : null);
    return { ...nodeContext(HOME, fakeFs()), foldCase: true, readScript };
  };
  const MAIN = "git push origin HEAD:main";
  it.each([
    `sudo $a a1.sh; sudo $a a2.sh; sudo $a a3.sh; sudo $a a4.sh; ${MAIN}`,
    `$b a1.sh; $b a2.sh; $b a3.sh; $b a4.sh; ${MAIN}`,
    `timeout $O 5 timeout $P a1.sh a2.sh; env $E a3.sh; nohup $a a4.sh; ${MAIN}`,
    `${MAIN}; timeout $O 5 timeout $P a1.sh a2.sh; env $E a3.sh; nohup $a a4.sh`,
    `sudo $a a1.sh; sudo $a a2.sh; sudo $a a3.sh; ${MAIN}`,
    `sh -c 'sudo $a a1.sh; sh -c "sudo \\$a a2.sh"'; ${MAIN}`,
    `xargs sudo $a a1.sh; xargs sudo $a a2.sh; ${MAIN}`,
  ])("denies `%s`, each script 63 KB, case folding on", async (line) => {
    const result = await handle(bash(line), {}, port({ context: pads("a1.sh", "a2.sh", "a3.sh", "a4.sh") }));

    expect(decisionOf(result.stdout)).toBe("deny");
    expect(result.log[0]?.split("\t").slice(4, 5)).toEqual(["bash.oversize"]);
  }, 30_000);

  it("reads four distinct scripts behind dynamic wrappers when together they are small", async () => {
    const small: Record<string, string> = { a1: "echo hi; ".repeat(200), a2: "echo hi; ".repeat(200), a3: "echo hi; ".repeat(200), a4: MAIN };
    const context = { ...nodeContext(HOME, fakeFs()), foldCase: true, readScript: (p: string) => small[path.basename(p, ".sh")] ?? null };

    const result = await handle(bash("sudo $a a1.sh; sudo $a a2.sh; sudo $a a3.sh; sudo $a a4.sh"), {}, port({ context }));

    expect(decisionOf(result.stdout)).toBe("deny");
    expect(result.log[0]?.split("\t").slice(4, 5)).toEqual(["bash.merge.git-push-protected"]);
  });

  it("denies a line whose scripts together pass the budget, and says to run each in its own command", async () => {
    const result = await handle(bash("bash a1.sh; bash a2.sh"), {}, port({ context: pads("a1.sh", "a2.sh") }));

    expect(decisionOf(result.stdout)).toBe("deny");
    expect(result.stdout).toMatch(/run a2\.sh in its own command/);
    expect(result.log[0]?.split("\t").slice(1, 5)).toEqual(["deny", "none", "oversize", "bash.oversize"]);
  }, 30_000);

  it("reads a 63 KB script run twice with no switch between once, and denies the push after it", async () => {
    const result = await handle(bash(`. a1.sh; . a1.sh; ${MAIN}`), {}, port({ context: pads("a1.sh") }));

    expect(result.log[0]?.split("\t").slice(4, 5)).toEqual(["bash.merge.git-push-protected"]);
  }, 30_000);

  it("denies a 63 KB script run again after a branch switch as past the budget", async () => {
    const result = await handle(bash(`. a1.sh; git checkout feat/y && . a1.sh; ${MAIN}`), {}, port({ context: pads("a1.sh") }));

    expect(result.log[0]?.split("\t").slice(4, 5)).toEqual(["bash.oversize"]);
  }, 30_000);

  it("denies a command past the reading budget with the retired bypass variable in the hook's env", async () => {
    const result = await handle(bash(`${"sudo $a ".repeat(400)}git status`), RETIRED_BYPASS, port());

    expect(decisionOf(result.stdout)).toBe("deny");
  });

  it("denies a credential read padded past the size cap without classifying it", async () => {
    const padded = `${"x ".repeat(20_000)}; cat ~/.npmrc`;
    let result: HookResult = { stdout: "", log: [] };

    const work = await countWork(async () => (result = await handle(bash(padded), {}, port())));

    expect(work).toBeLessThan(UNREAD_WORK);
    expect(decisionOf(result.stdout)).toBe("deny");
    expect(result.log[0]?.split("\t").slice(1, 5)).toEqual(["deny", "none", "oversize", "bash.oversize"]);
  });

  it("denies a large command that names nothing guarded, and says to split it or use a script", async () => {
    const result = await handle(bash(`${"x ".repeat(20_000)}; echo done`), {}, port());

    expect(decisionOf(result.stdout)).toBe("deny");
    expect(result.stdout).toMatch(/split it into shorter commands, or write the steps to a script file/);
    expect(result.log[0]?.split("\t").slice(1, 5)).toEqual(["deny", "none", "oversize", "bash.oversize"]);
  });

  it.each([
    "gh pr mer''ge 3",
    'gh pr "merge" 3',
    "gh  pr  merge 3",
    "cat ~/.np''mrc",
    "cat ~/.np*rc",
    "F=mrc; cat ~/.np$F",
    "pnpm pub''lish",
  ])("denies %s padded just past the size cap", async (spelling) => {
    const padded = `${"x ".repeat(Math.ceil(MAX_COMMAND_BYTES / 2))}; ${spelling}`;

    const result = await handle(bash(padded), {}, port());

    expect(Buffer.byteLength(padded)).toBeLessThan(MAX_COMMAND_BYTES + 200);
    expect(decisionOf(result.stdout)).toBe("deny");
  });

  it("denies an oversize command with the retired bypass variable in the hook's env", async () => {
    const result = await handle(bash(`${"x ".repeat(20_000)}; echo done`), RETIRED_BYPASS, port());

    expect(decisionOf(result.stdout)).toBe("deny");
  });

  it.each([
    "gh pr mer''ge 3; echo 'x",
    'gh pr "merge" 3; echo \'x',
    "gh  pr  merge 3; echo 'x",
    "cat ~/.np''mrc; echo 'x",
    "gh pr mer\\ge 3; echo 'x",
  ])("sees through quoting when %s cannot be parsed", async (command) => {
    const result = await handle(bash(command), {}, port());

    expect(decisionOf(result.stdout)).toBe("deny");
    expect(result.log[0]?.split("\t").slice(1, 5)).toEqual(["deny", "none", "unparsed", "bash.unparsed"]);
  });

  it("denies an unparseable quoted command that names nothing guarded, and says to simplify it", async () => {
    const result = await handle(bash("echo 'he''llo' \"wor  ld\"; echo 'x"), {}, port());

    expect(decisionOf(result.stdout)).toBe("deny");
    expect(result.stdout).toContain("split it into simpler commands");
  });

  it("still classifies a command just under the size cap", async () => {
    const command = `${"x ".repeat((MAX_COMMAND_BYTES - 40) / 2)}; cat ~/.npmrc`;

    const result = await handle(bash(command), {}, port());

    expect(result.log[0]?.split("\t").slice(1, 5)).toEqual(["deny", "SEC-CO", "secret-read", "bash.secret.cat"]);
  });

  it("denies every command when the classifier throws", async () => {
    const context = { get home(): string { throw new Error("boom"); } } as unknown as ClassifyContext;

    const guarded = await handle(bash("gh pr merge 3"), {}, port({ context }));
    const plain = await handle(bash("ls"), {}, port({ context }));

    expect([guarded, plain].map((r) => decisionOf(r.stdout))).toEqual(["deny", "deny"]);
  });

  it("fails closed for a classified event when the authority table cannot load", async () => {
    const broken = port({ loadDecide: () => Promise.reject(new Error("table")) });

    const merge = await handle(bash("gh pr merge 3"), {}, broken);
    const plain = await handle(bash("ls"), {}, broken);

    expect(decisionOf(merge.stdout)).toBe("deny");
    expect(merge.log.map((l) => l.split("\t")[1])).toEqual(["error", "deny"]);
    expect(plain).toEqual({ stdout: "", log: [] });
  });

  it("never throws, even when the clock port does", async () => {
    const result = await handle("{", {}, port({ now: () => { throw new Error("clock"); } }));

    expect(result).toEqual({ stdout: "", log: [] });
  });
});

describe("handle: what passes", () => {
  it("does not scan a commit message heredoc that mentions a merge", async () => {
    const result = await handle(bash("git commit -F - <<'EOF'\nRun gh pr merge 12 after review\nEOF"), {}, port());

    expect(result).toEqual({ stdout: "", log: [] });
  });

  it("denies a merge with the retired bypass variable in the hook's launch env, as an agent's child claude would have it", async () => {
    const result = await handle(bash("gh pr merge 3"), RETIRED_BYPASS, port());

    expect(decisionOf(result.stdout)).toBe("deny");
    expect(result.log[0]?.split("\t").slice(1, 6)).toEqual(["deny", "MRG-WK", "merge", "bash.merge.gh-pr-merge", "coordinator+worker+headless"]);
  });

  it("passes a routine command without logging", async () => {
    expect(await handle(bash("git status && pnpm test"), {}, port())).toEqual({ stdout: "", log: [] });
  });
});

describe("handle: a push rerouted by the command's own config", () => {
  it("denies a feature-branch push that -c remote.origin.push maps onto main", async () => {
    const result = await handle(bash("git -c remote.origin.push=refs/heads/feat:refs/heads/main push origin feat"), {}, port());

    expect(decisionOf(result.stdout)).toBe("deny");
    expect(result.log[0]?.split("\t").slice(1, 5)).toEqual(["deny", "MRG-WK", "merge", "bash.merge.git-push-protected"]);
  });
});

describe("namesGuarded", () => {
  it("finds guarded paths, basenames and keywords in any case", () => {
    expect(namesGuarded("cat ~/.NPMRC")).toBe(true);
    expect(namesGuarded("find / -name id_ed25519")).toBe(true);
    expect(namesGuarded("pnpm publish")).toBe(true);
    expect(namesGuarded("echo hello")).toBe(false);
  });

  it("sees through quotes, backslashes and whitespace runs", () => {
    expect(namesGuarded("pnpm pub''lish")).toBe(true);
    expect(namesGuarded('gh pr "merge" 3')).toBe(true);
    expect(namesGuarded("gh \t pr   merge 3")).toBe(true);
    expect(namesGuarded("cat ~/.np\\mrc")).toBe(true);
  });

  it("does not expand variables or globs (owner decision D6 residual)", () => {
    expect(namesGuarded("F=mrc; cat ~/.np$F")).toBe(false);
    expect(namesGuarded("cat ~/.np*rc")).toBe(false);
  });
});

describe("nodeContext over a real temp directory", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function tempHome(): string {
    const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "tool-guard-home-")));
    dirs.push(dir);
    return dir;
  }

  it("reads the branch of a checkout and of a worktree", () => {
    const home = tempHome();
    fs.mkdirSync(path.join(home, "app/.git"), { recursive: true });
    fs.writeFileSync(path.join(home, "app/.git/HEAD"), "ref: refs/heads/main\n");
    fs.mkdirSync(path.join(home, "wt"));
    fs.mkdirSync(path.join(home, "app/.git/worktrees/wt"), { recursive: true });
    fs.writeFileSync(path.join(home, "app/.git/worktrees/wt/HEAD"), "ref: refs/heads/feat/x\n");
    fs.writeFileSync(path.join(home, "wt/.git"), "gitdir: ../app/.git/worktrees/wt\n");
    const ctx = nodeContext(home);

    expect(ctx.readHead(path.join(home, "app/src"))).toBe("main");
    expect(ctx.readHead(path.join(home, "wt"))).toBe("feat/x");
  });

  it("reads scripts that are regular files only, and refuses any other", () => {
    const home = tempHome();
    fs.writeFileSync(path.join(home, "x.sh"), "echo hi\n");
    const ctx = nodeContext(home);

    expect(ctx.readScript(path.join(home, "x.sh"))).toBe("echo hi\n");
    expect(() => ctx.readScript(home)).toThrow(UnreadableScriptError);
    expect(() => ctx.readScript(path.join(home, "missing.sh"))).toThrow(UnreadableScriptError);
  });

  it("maps a link resolved through a symlinked home back to the home spelling", () => {
    const real = tempHome();
    const alias = path.join(tempHome(), "alias");
    fs.symlinkSync(real, alias);
    fs.writeFileSync(path.join(real, "invented-file"), "");

    expect(nodeContext(alias).readLink(path.join(alias, "invented-file"))).toBe(path.join(alias, "invented-file"));
  });

  const probe = fs.mkdtempSync(path.join(os.tmpdir(), "tool-guard-case-"));
  fs.writeFileSync(path.join(probe, "a"), "");
  const caseInsensitive = fs.existsSync(path.join(probe, "A"));
  fs.rmSync(probe, { recursive: true, force: true });

  it.runIf(caseInsensitive)("resolves a case variant to the on-disk name", async () => {
    const home = tempHome();
    fs.writeFileSync(path.join(home, ".npmrc"), "");

    const { stdout } = await handle(bash("cat ~/.NPMRC"), {}, port({ context: nodeContext(home) }));

    expect(decisionOf(stdout)).toBe("deny");
  });
});

describe("handle over real script files behind dynamic wrapper words, case folding on", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  const fill = (unit: string, bytes: number) => unit.repeat(Math.ceil(bytes / unit.length)).slice(0, bytes);
  const PATHS = "/a /b /c /d /e /f /g /h ";
  const MAIN = "git push origin HEAD:main";
  /** Linear growth costs SCALE x the small case's work, quadratic SCALE^2 x; work counts, unlike time, no load moves. */
  const SCALE = 8;
  // Sizes stay under MAX_SCRIPT_BYTES: past it the hook denies unread, which costs nothing and proves nothing.

  /** Writes `files` into a checkout on feat/x and returns a run of `command` from it, read through the real filesystem. */
  function inCheckout(command: string, files: Record<string, string>) {
    const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "tool-guard-home-")));
    dirs.push(home);
    const repo = path.join(home, "app");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".git/HEAD"), "ref: refs/heads/feat/x\n");
    for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(repo, name), text);
    return () => handle(bash(command, { cwd: repo }), {}, port({ context: { ...nodeContext(home), foldCase: true } }));
  }

  const inRepo = (command: string, files: Record<string, string>) => inCheckout(command, files)();

  type Case = { command: string; files: Record<string, string> };

  /** Counts the work of `build` at `size` and SCALE times it, each in a fresh checkout, and asserts both deny. */
  async function expectNearLinear(build: (size: number) => Case, size: number) {
    const decisions: Array<string | null> = [];
    await expectLinearWork((n) => {
      const { command, files } = build(n);
      const run = inCheckout(command, files);
      return async () => decisions.push(decisionOf((await run()).stdout));
    }, size * SCALE);
    expect(decisions).toEqual(["deny", "deny"]);
  }

  it.each([
    ["python3", "a.py", 1024],
    ["node", "a.js", 1024],
  ])("denies a push after `sudo $a %s` running a script of paths, cost near-linear in size", async (interpreter, script, bytes) => {
    await expectNearLinear(
      (size) => ({ command: `sudo $a ${interpreter} ${script}; ${MAIN}`, files: { [script]: fill(PATHS, size) } }),
      bytes,
    );
  }, 30_000);

  it("denies a push after `sudo $a b.sh` and 8 KB of reads, b.sh 8 KiB of reads", async () => {
    await expectNearLinear(
      (size) => ({
        command: `sudo $a b.sh; ${fill("cat x; ", size - 192)}${MAIN}`,
        files: { "b.sh": fill("cat x\n", size) },
      }),
      1024,
    );
  }, 30_000);

  it("passes a lone `$SUDO ./install.sh` of 12 KB, as main does", async () => {
    const result = await inRepo("$SUDO ./install.sh", { "install.sh": fill("echo installing\n", 12_000) });

    expect(result).toEqual({ stdout: "", log: [] });
  });

  it("refuses a large script behind a dynamic wrapper with the limit, its size and a command that passes", async () => {
    const files = { "install.sh": fill("echo installing\n", 40_000) };

    const refused = await inRepo("$SUDO ./install.sh", files);
    const advised = await inRepo("sudo ./install.sh", files);

    expect(decisionOf(refused.stdout)).toBe("deny");
    expect(refused.stdout).toMatch(/16 KiB.*install\.sh holds 40 KiB.*write the wrapper out/);
    expect(advised).toEqual({ stdout: "", log: [] });
  });

  const INSTALL = "$SUDO cp ./etc/a.conf /etc/a.conf\n".repeat(176);
  const STATUS = "timeout $T git status\n".repeat(181);
  it.each([
    ["./inst.sh", { "inst.sh": INSTALL }],
    ["sudo ./inst.sh", { "inst.sh": INSTALL }],
    ["bash ./tmo.sh", { "tmo.sh": STATUS }],
  ])("passes `%s`, a lone script of more dynamic wrapper words than a line may hold, as main does", async (command, files) => {
    const result = await inRepo(command, files);

    expect(result).toEqual({ stdout: "", log: [] });
  });

  it("refuses a line of more dynamic wrapper words than it checks, and the script file it advises then passes", async () => {
    const steps = "$S cp a b\n".repeat(171);

    const refused = await inRepo(steps.replaceAll("\n", "; "), {});
    const advised = await inRepo("./steps.sh", { "steps.sh": steps });

    expect(decisionOf(refused.stdout)).toBe("deny");
    expect(refused.stdout).toMatch(/write the steps to a script file and run that/);
    expect(advised).toEqual({ stdout: "", log: [] });
  });

  it("still denies a push in a script after more dynamic wrapper words than a line may hold", async () => {
    const result = await inRepo("./steps.sh", { "steps.sh": `${"$S cp a b\n".repeat(171)}${MAIN}\n` });

    expect(result.log[0]?.split("\t").slice(4, 5)).toEqual(["bash.merge.git-push-protected"]);
  });

  /**
   * The guarded-path globs run as a LinearRegExp NFA, whose steps countWork cannot see. The row below reads four 34 KiB
   * scripts in about 0.75 steps a byte; without matchGuarded's memo it took 2 800 a byte and passed its timeout on a
   * loaded runner (TP-4255). A step cap fails that on an assertion instead (TP-4262).
   */
  const GLOB_STEPS_PER_BYTE = 2;

  it("refuses scripts past the line's budget, names the script to split off, and each half then passes", async () => {
    const files = { "a1.sh": fill("echo hi\n", 34 * 1024), "a2.sh": fill("echo hi\n", 34 * 1024) };

    const before = linearRegExpSteps();
    const refused = await inRepo("bash a1.sh; bash a2.sh", files);
    // Checked before the halves, so a regression fails after one run instead of three.
    expect(linearRegExpSteps() - before, "LinearRegExp steps").toBeLessThan(GLOB_STEPS_PER_BYTE * 2 * 34 * 1024);
    const halves = [await inRepo("bash a1.sh", files), await inRepo("bash a2.sh", files)];
    expect(linearRegExpSteps() - before, "LinearRegExp steps").toBeLessThan(GLOB_STEPS_PER_BYTE * 4 * 34 * 1024);

    expect(decisionOf(refused.stdout)).toBe("deny");
    expect(refused.stdout).toMatch(/64 KiB.*reach 68 KiB at a2\.sh.*run a2\.sh in its own command/);
    expect(halves).toEqual([{ stdout: "", log: [] }, { stdout: "", log: [] }]);
  }, 30_000);
});
