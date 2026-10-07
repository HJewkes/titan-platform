import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BYPASS_VAR } from "./actor.js";
import { nodeContext } from "./context.js";
import type { ReadFs } from "./context.js";
import { decide } from "./decide.js";
import { handle, MAX_COMMAND_BYTES, namesGuarded } from "./hook.js";
import type { HookPort } from "./hook.js";
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

  it("denies an unparseable command that names a guarded path, and passes one that does not", async () => {
    const guarded = await handle(bash("cat ~/.npmrc 'x"), {}, port());
    const plain = await handle(bash("echo 'x"), {}, port());

    expect(decisionOf(guarded.stdout)).toBe("deny");
    expect(guarded.log[0]?.split("\t").slice(1, 5)).toEqual(["deny", "none", "unparsed", "bash.unparsed"]);
    expect(plain).toEqual({ stdout: "", log: ["2026-01-02T03:04:05.000Z\terror\tparse\tBash\tsess-1"] });
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
    expect(result.stdout).toMatch(/run each script in its own command/);
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

  it("passes a command past the reading budget under the bypass and logs it", async () => {
    const result = await handle(bash(`${"sudo $a ".repeat(400)}git status`), { [BYPASS_VAR]: "1" }, port());

    expect(result).toEqual({ stdout: "", log: ["2026-01-02T03:04:05.000Z\terror\toversize\tBash\tsess-1"] });
  });

  it("denies a credential read padded past the size cap without classifying it", async () => {
    const padded = `${"x ".repeat(20_000)}; cat ~/.npmrc`;
    const start = performance.now();

    const result = await handle(bash(padded), {}, port());

    expect(performance.now() - start).toBeLessThan(500);
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

  it("passes an oversize command under the bypass and logs it", async () => {
    const result = await handle(bash(`${"x ".repeat(20_000)}; echo done`), { [BYPASS_VAR]: "1" }, port());

    expect(result).toEqual({ stdout: "", log: ["2026-01-02T03:04:05.000Z\terror\toversize\tBash\tsess-1"] });
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

  it("passes an unparseable quoted command that names nothing guarded, with an error line", async () => {
    const result = await handle(bash("echo 'he''llo' \"wor  ld\"; echo 'x"), {}, port());

    expect(result).toEqual({ stdout: "", log: ["2026-01-02T03:04:05.000Z\terror\tparse\tBash\tsess-1"] });
  });

  it("still classifies a command just under the size cap", async () => {
    const command = `${"x ".repeat((MAX_COMMAND_BYTES - 40) / 2)}; cat ~/.npmrc`;

    const result = await handle(bash(command), {}, port());

    expect(result.log[0]?.split("\t").slice(1, 5)).toEqual(["deny", "SEC-CO", "secret-read", "bash.secret.cat"]);
  });

  it("applies the same split to an exception inside the classifier", async () => {
    const context = { get home(): string { throw new Error("boom"); } } as unknown as ClassifyContext;

    const guarded = await handle(bash("gh pr merge 3"), {}, port({ context }));
    const plain = await handle(bash("ls"), {}, port({ context }));

    expect(decisionOf(guarded.stdout)).toBe("deny");
    expect(plain.stdout).toBe("");
    expect(plain.log[0]).toContain("\terror\texception\tBash\t");
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

  it("passes a bypass set at launch and logs it as bypass", async () => {
    const result = await handle(bash("gh pr merge 3"), { [BYPASS_VAR]: "1" }, port());

    expect(result.stdout).toBe("");
    expect(result.log[0]?.split("\t").slice(1, 6)).toEqual(["bypass", "MRG-OT", "merge", "bash.merge.gh-pr-merge", "owner-terminal"]);
  });

  it("ignores the bypass variable written inline in the command", async () => {
    const result = await handle(bash(`${BYPASS_VAR}=1 gh pr merge 3`), {}, port());

    expect(decisionOf(result.stdout)).toBe("deny");
  });

  it("passes a routine command without logging", async () => {
    expect(await handle(bash("git status && pnpm test"), {}, port())).toEqual({ stdout: "", log: [] });
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

  it("reads scripts that are regular files only", () => {
    const home = tempHome();
    fs.writeFileSync(path.join(home, "x.sh"), "echo hi\n");
    const ctx = nodeContext(home);

    expect(ctx.readScript(path.join(home, "x.sh"))).toBe("echo hi\n");
    expect(ctx.readScript(home)).toBeNull();
    expect(ctx.readScript(path.join(home, "missing.sh"))).toBeNull();
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
