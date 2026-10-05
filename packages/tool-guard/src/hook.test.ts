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

  it("denies a credential read padded past the size cap without classifying it", async () => {
    const padded = `${"x ".repeat(20_000)}; cat ~/.npmrc`;
    const start = performance.now();

    const result = await handle(bash(padded), {}, port());

    expect(performance.now() - start).toBeLessThan(500);
    expect(decisionOf(result.stdout)).toBe("deny");
    expect(result.log[0]?.split("\t").slice(1, 5)).toEqual(["deny", "none", "oversize", "bash.oversize"]);
  });

  it("passes a large command that names nothing guarded, and logs it as oversize", async () => {
    const result = await handle(bash(`${"x ".repeat(20_000)}; echo done`), {}, port());

    expect(result).toEqual({ stdout: "", log: ["2026-01-02T03:04:05.000Z\terror\toversize\tBash\tsess-1"] });
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
