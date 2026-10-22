import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { execGit, ratchetFastForward, remoteDefaultBranch, seedRatchet } from "./ratchet.js";

const IDENTITY = ["-c", "user.name=ratchet fixture", "-c", "user.email=fixture@example.invalid"];
const git = (cwd: string, ...args: string[]) => execGit([...IDENTITY, ...args], cwd);

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

/** A bare `origin` and one checkout of it, the shape of an integration tree. */
async function fixtureRepo() {
  const root = mkdtempSync(join(tmpdir(), "ar-ratchet-"));
  roots.push(root);
  const bare = join(root, "origin.git");
  const work = join(root, "work");
  mkdirSync(work);
  await git(work, "init", "--quiet", "-b", "main");
  await git(work, "commit", "--quiet", "--allow-empty", "-m", "fixture");
  await git(root, "clone", "--quiet", "--bare", work, bare);
  await git(work, "remote", "add", "origin", bare);
  return { bare, work, pin: await git(work, "rev-parse", "HEAD") };
}

const PREFIX = "autoresearch/fixture";
const REF = `refs/heads/${PREFIX}/run-1`;

async function commit(work: string, message: string): Promise<string> {
  await git(work, "commit", "--quiet", "--allow-empty", "-m", message);
  return git(work, "rev-parse", "HEAD");
}

async function withRatchet() {
  const repo = await fixtureRepo();
  await git(repo.work, "push", "--quiet", "origin", `${repo.pin}:${REF}`);
  const winner = await commit(repo.work, "winner");
  return { repo, winner, move: { tree: repo.work, ratchetRef: REF, ratchetPrefix: PREFIX, defaultBranch: "main", from: repo.pin, to: winner } };
}

describe("ratchet fast-forward", () => {
  it("moves the remote ratchet ref to the winner", async () => {
    const { repo, winner, move } = await withRatchet();

    expect(await ratchetFastForward(execGit, move)).toEqual({ head: winner });
    expect(await git(repo.bare, "rev-parse", REF)).toBe(winner);
  });

  it("refuses main by its own code and leaves the remote main alone", async () => {
    const { repo, move } = await withRatchet();

    await expect(ratchetFastForward(execGit, { ...move, ratchetRef: "refs/heads/main" })).rejects.toThrow("[ratchet-main]");
    expect(await git(repo.bare, "rev-parse", "refs/heads/main")).toBe(repo.pin);
  });

  it("refuses the remote's default branch even when it sits under the ratchet prefix", async () => {
    const { repo, move } = await withRatchet();
    const trunk = `refs/heads/${PREFIX}/trunk`;
    await git(repo.work, "push", "--quiet", "origin", `${repo.pin}:${trunk}`);
    await git(repo.bare, "symbolic-ref", "HEAD", trunk);

    const defaultBranch = await remoteDefaultBranch(execGit, repo.work);

    expect(defaultBranch).toBe(`${PREFIX}/trunk`);
    await expect(ratchetFastForward(execGit, { ...move, ratchetRef: trunk, defaultBranch })).rejects.toThrow("[ratchet-default]");
    expect(await git(repo.bare, "rev-parse", trunk)).toBe(repo.pin);
  });

  it("fails closed when the remote HEAD names no branch", async () => {
    const repo = await fixtureRepo();
    await git(repo.bare, "symbolic-ref", "HEAD", "refs/heads/absent");

    await expect(remoteDefaultBranch(execGit, repo.work)).rejects.toThrow("[ratchet-default] unknown");
  });

  it.each([
    ["a branch outside the prefix", "refs/heads/other/run-1"],
    ["the prefix with nothing after it", `refs/heads/${PREFIX}/`],
  ])("refuses %s", async (_name, ratchetRef) => {
    const { move } = await withRatchet();

    await expect(ratchetFastForward(execGit, { ...move, ratchetRef })).rejects.toThrow("[ratchet-ref]");
  });

  it.each([
    ["an empty prefix", "", "refs/heads//run-1"],
    ["a bare slash prefix", "/", "refs/heads///run-1"],
  ])("refuses %s before reading the remote", async (_name, ratchetPrefix, ratchetRef) => {
    const { move } = await withRatchet();

    await expect(ratchetFastForward(execGit, { ...move, ratchetPrefix, ratchetRef })).rejects.toThrow("[ratchet-prefix]");
  });

  it("refuses a stale lease when the remote ratchet is not at the judged head, and leaves it there", async () => {
    const { repo, move } = await withRatchet();
    const elsewhere = await commit(repo.work, "elsewhere");
    await git(repo.work, "push", "--quiet", "--force", "origin", `${elsewhere}:${REF}`);

    await expect(ratchetFastForward(execGit, move)).rejects.toThrow("[ratchet-moved]");
    expect(await git(repo.bare, "rev-parse", REF)).toBe(elsewhere);
  });

  it("refuses the push when the ratchet is reset between the read and the push", async () => {
    const repo = await fixtureRepo();
    const judged = await commit(repo.work, "judged");
    await git(repo.work, "push", "--quiet", "origin", `${judged}:${REF}`);
    const winner = await commit(repo.work, "winner");
    const racing = async (args: readonly string[], cwd: string) => {
      const out = await execGit(args, cwd);
      if (args[0] === "ls-remote") await git(repo.bare, "update-ref", REF, repo.pin);
      return out;
    };

    await expect(ratchetFastForward(racing, { tree: repo.work, ratchetRef: REF, ratchetPrefix: PREFIX, defaultBranch: "main", from: judged, to: winner })).rejects.toThrow();
    expect(await git(repo.bare, "rev-parse", REF)).toBe(repo.pin);
  });
});

describe("ratchet seed", () => {
  const seedOf = (work: string, pin: string) => ({ tree: work, ratchetRef: REF, ratchetPrefix: PREFIX, defaultBranch: "main", pin });

  it("creates the run's ratchet at the pin", async () => {
    const repo = await fixtureRepo();

    await seedRatchet(execGit, seedOf(repo.work, repo.pin));

    expect(await git(repo.bare, "rev-parse", REF)).toBe(repo.pin);
  });

  it("leaves a ratchet already at the pin alone, so a restarted pin succeeds", async () => {
    const repo = await fixtureRepo();
    await seedRatchet(execGit, seedOf(repo.work, repo.pin));

    await seedRatchet(execGit, seedOf(repo.work, repo.pin));

    expect(await git(repo.bare, "rev-parse", REF)).toBe(repo.pin);
  });

  it("refuses a ratchet that already exists at another commit and leaves it there", async () => {
    const repo = await fixtureRepo();
    await git(repo.work, "push", "--quiet", "origin", `${repo.pin}:${REF}`);
    const later = await commit(repo.work, "later pin");

    await expect(seedRatchet(execGit, seedOf(repo.work, later))).rejects.toThrow("[ratchet-exists]");
    expect(await git(repo.bare, "rev-parse", REF)).toBe(repo.pin);
  });

  it("passes on a push failure that no existing ref explains, so it is not mistaken for a taken ratchet", async () => {
    const repo = await fixtureRepo();
    const offline = async (args: readonly string[], cwd: string) => {
      if (args[0] === "push") throw new Error("fixture: remote unreachable");
      return execGit(args, cwd);
    };

    await expect(seedRatchet(offline, seedOf(repo.work, repo.pin))).rejects.toThrow("fixture: remote unreachable");
  });

  it("runs the ref guard before it pushes", async () => {
    const repo = await fixtureRepo();
    const later = await commit(repo.work, "later pin");

    await expect(seedRatchet(execGit, { ...seedOf(repo.work, later), ratchetRef: "refs/heads/main" })).rejects.toThrow("[ratchet-main]");
    expect(await git(repo.bare, "rev-parse", "refs/heads/main")).toBe(repo.pin);
  });
});
