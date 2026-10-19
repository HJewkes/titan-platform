import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { execGit, type GhExecOptions, type GhResult, type GitExec } from "./exec.js";
import { fakeGitHub } from "./fake.js";
import { LsRemoteError, lsRemotePullHead } from "./ls-remote.js";
import { GitHubInputError } from "./validate.js";

const REMOTE = "https://example.test/o/r.git";
const A = "a".repeat(40);
const TOKEN = "ghs_" + "x".repeat(36);

function scripted(answer: GhResult | Error): { exec: GitExec; calls: { args: readonly string[]; options?: GhExecOptions }[] } {
  const calls: { args: readonly string[]; options?: GhExecOptions }[] = [];
  const exec: GitExec = async (args, options) => {
    calls.push({ args, options });
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { exec, calls };
}

async function failureOf(read: Promise<unknown>): Promise<Error> {
  const outcome = await read.then(
    () => undefined,
    (error: unknown) => error,
  );
  if (!(outcome instanceof Error)) throw new Error("expected the read to fail");
  return outcome;
}

describe("lsRemotePullHead", () => {
  it("answers the sha of refs/pull/<n>/head", async () => {
    const git = scripted({ code: 0, stdout: `${A}\trefs/pull/7/head\n`, stderr: "" });

    const head = await lsRemotePullHead(git.exec, REMOTE, 7);

    expect(head).toBe(A);
    expect(git.calls[0]!.args).toEqual(["ls-remote", "--", REMOTE, "refs/pull/7/head"]);
  });

  it("answers null when the remote has no such ref", async () => {
    const git = scripted({ code: 0, stdout: "", stderr: "" });

    await expect(lsRemotePullHead(git.exec, REMOTE, 7)).resolves.toBeNull();
  });

  it("ignores a longer ref that only ends with the pull ref, since git matches patterns by tail", async () => {
    const git = scripted({ code: 0, stdout: `${A}\trefs/remotes/fork/refs/pull/7/head\n`, stderr: "" });

    await expect(lsRemotePullHead(git.exec, REMOTE, 7)).resolves.toBeNull();
  });

  it("throws a read failure, not a sha, when git exits non-zero", async () => {
    const git = scripted({ code: 128, stdout: `${A}\trefs/pull/7/head\n`, stderr: "fatal: unable to access remote\n" });

    await expect(lsRemotePullHead(git.exec, REMOTE, 7)).rejects.toThrow(LsRemoteError);
  });

  it("throws a read failure when git cannot run at all", async () => {
    const git = scripted(new Error("git timed out after 30000 ms"));

    await expect(lsRemotePullHead(git.exec, REMOTE, 7)).rejects.toThrow(/ls-remote refs\/pull\/7\/head failed: git timed out/);
  });

  it("throws on an answer that is no object id", async () => {
    const git = scripted({ code: 0, stdout: "not-a-sha\trefs/pull/7/head\n", stderr: "" });

    await expect(lsRemotePullHead(git.exec, REMOTE, 7)).rejects.toThrow(LsRemoteError);
  });

  it("passes the credential in the child env only, never on argv, and cuts it from errors", async () => {
    const git = scripted({ code: 128, stdout: "", stderr: `fatal: auth failed for ${TOKEN}\n` });
    const env = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: Bearer ${TOKEN}` };

    const failure = await failureOf(lsRemotePullHead(git.exec, REMOTE, 7, { env }));

    expect(git.calls[0]!.args.some((arg) => arg.includes(TOKEN))).toBe(false);
    expect(git.calls[0]!.options?.env).toMatchObject({ ...env, GIT_TERMINAL_PROMPT: "0" });
    expect(failure.message).not.toContain(TOKEN);
  });

  it.each([
    ["a credential in the URL", `https://x-access-token:${TOKEN}@example.test/o/r.git`],
    ["a plain-http URL", "http://example.test/o/r.git"],
    ["an ext:: transport", "ext::sh -c touch% /tmp/pwned"],
    ["a relative path", "o/r.git"],
  ])("refuses %s before git runs", async (_case, url) => {
    const git = scripted({ code: 0, stdout: "", stderr: "" });

    const failure = await failureOf(lsRemotePullHead(git.exec, url, 7));

    expect(failure).toBeInstanceOf(GitHubInputError);
    expect(failure.message).not.toContain(TOKEN);
    expect(git.calls).toEqual([]);
  });

  it("refuses a pull number that is not a positive integer", async () => {
    const git = scripted({ code: 0, stdout: "", stderr: "" });

    await expect(lsRemotePullHead(git.exec, REMOTE, 0)).rejects.toThrow(GitHubInputError);
  });
});

describe("lsRemotePullHead on the fake", () => {
  it("answers a PR's current head and null for a PR the fake lacks", async () => {
    const fake = fakeGitHub();
    const pr = fake.addPr({ headSha: A });

    const [present, absent] = [await lsRemotePullHead(fake.gitExec, REMOTE, pr.number), await lsRemotePullHead(fake.gitExec, REMOTE, 99)];

    expect([present, absent]).toEqual([A, null]);
  });

  it("follows a foreign push", async () => {
    const fake = fakeGitHub();
    const pr = fake.addPr({ headSha: A });
    fake.pushHead(pr.number, "b".repeat(40));

    await expect(lsRemotePullHead(fake.gitExec, REMOTE, pr.number)).resolves.toBe("b".repeat(40));
  });

  it("turns a seeded fault into a read failure", async () => {
    const fake = fakeGitHub();
    fake.addPr({ headSha: A });
    fake.readFaults.lsRemote = [new Error("connection reset")];

    await expect(lsRemotePullHead(fake.gitExec, REMOTE, 1)).rejects.toThrow(LsRemoteError);
  });
});

describe("lsRemotePullHead against real git", () => {
  const dir = mkdtempSync(join(tmpdir(), "ls-remote-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("reads refs/pull/<n>/head from a local remote", async () => {
    const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
    git("init", "-q");
    git("-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "-q", "--allow-empty", "-m", "x");
    const head = git("rev-parse", "HEAD");
    git("update-ref", "refs/pull/3/head", head);

    const [present, absent] = [await lsRemotePullHead(execGit, pathToFileURL(dir).href, 3), await lsRemotePullHead(execGit, pathToFileURL(dir).href, 4)];

    expect([present, absent]).toEqual([head, null]);
  });
});
