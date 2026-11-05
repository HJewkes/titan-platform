import type { GhExecOptions, GitExec } from "@titan-design/github";
import { describe, expect, it } from "vitest";
import { botGitEnv, botLsRemote } from "./bot-ls-remote.js";

/** Built, not written out, so no source line carries a token-shaped literal. */
const TOKEN = `ghp_${"SYNTHETICsentinel".padEnd(36, "0")}`;
const A = "a".repeat(40);

function git(answer: { code: number; stdout: string; stderr?: string } | Error): { exec: GitExec; calls: { args: readonly string[]; options?: GhExecOptions }[] } {
  const calls: { args: readonly string[]; options?: GhExecOptions }[] = [];
  const exec: GitExec = async (args, options) => {
    calls.push({ args, options });
    if (answer instanceof Error) throw answer;
    return { stderr: "", ...answer };
  };
  return { exec, calls };
}

describe("botLsRemote: git ls-remote as the bot (TP-3431)", () => {
  it("reads a PR head from refs/pull/<n>/head on the repo's GitHub remote", async () => {
    const run = git({ code: 0, stdout: `${A}\trefs/pull/7/head\n` });

    const head = await botLsRemote(TOKEN, run.exec)("example-org/widgets", { pr: 7 });

    expect(head).toBe(A);
    expect(run.calls[0]!.args).toEqual(["ls-remote", "--", "https://github.com/example-org/widgets.git", "refs/pull/7/head"]);
  });

  it("reads a branch tip from refs/heads/<branch>", async () => {
    const run = git({ code: 0, stdout: `${A}\trefs/heads/main\n` });

    await expect(botLsRemote(TOKEN, run.exec)("example-org/widgets", { branch: "main" })).resolves.toBe(A);
    expect(run.calls[0]!.args.at(-1)).toBe("refs/heads/main");
  });

  it("answers unavailable, never a sha, when git fails, with the token in no argument", async () => {
    const run = git({ code: 128, stdout: "", stderr: "fatal: could not read from remote\n" });

    const answer = await botLsRemote(TOKEN, run.exec)("example-org/widgets", { pr: 7 });

    expect(answer).toEqual({ kind: "unavailable" });
    expect(run.calls[0]!.args.join(" ")).not.toContain(TOKEN);
  });

  it("sends the bot's token as git's only credential, in the child env", async () => {
    const run = git({ code: 0, stdout: "" });

    await botLsRemote(TOKEN, run.exec)("example-org/widgets", { branch: "main" });

    expect(run.calls[0]!.options?.env).toEqual({ ...botGitEnv(TOKEN), GIT_TERMINAL_PROMPT: "0" });
  });
});

describe("botGitEnv: no route back to the user login's credential (I13)", () => {
  const env = botGitEnv(TOKEN);

  it("carries the token only as a basic auth header scoped to github.com", () => {
    const basic = Buffer.from(`x-access-token:${TOKEN}`).toString("base64");

    expect([env.GIT_CONFIG_KEY_0, env.GIT_CONFIG_VALUE_0]).toEqual(["http.https://github.com/.extraheader", `AUTHORIZATION: basic ${basic}`]);
    expect(Object.values(env).filter((value) => value.includes(TOKEN))).toEqual([]);
  });

  it("shuts out the global, system and -c config, every credential helper and askpass, and every transport but https", () => {
    expect(env).toMatchObject({ GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_PARAMETERS: "", GIT_ASKPASS: "", GIT_ALLOW_PROTOCOL: "https" });
    expect([env.GIT_CONFIG_COUNT, env.GIT_CONFIG_KEY_1, env.GIT_CONFIG_VALUE_1]).toEqual(["2", "credential.helper", ""]);
  });
});
