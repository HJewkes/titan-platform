import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { execGit, ratchetFastForward } from "./ratchet.js";

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

const REF = "refs/heads/autoresearch/fixture/run-1";

async function withRatchet() {
  const repo = await fixtureRepo();
  await git(repo.work, "push", "--quiet", "origin", `${repo.pin}:${REF}`);
  await git(repo.work, "commit", "--quiet", "--allow-empty", "-m", "winner");
  const winner = await git(repo.work, "rev-parse", "HEAD");
  return { repo, winner, move: { tree: repo.work, ratchetRef: REF, ratchetPrefix: "autoresearch/fixture", from: repo.pin, to: winner } };
}

describe("ratchet fast-forward", () => {
  it("moves the remote ratchet ref to the winner", async () => {
    const { repo, winner, move } = await withRatchet();

    expect(await ratchetFastForward(execGit, move)).toEqual({ head: winner });
    expect(await git(repo.bare, "rev-parse", REF)).toBe(winner);
  });

  it("refuses a ref outside the ratchet prefix and leaves the remote alone", async () => {
    const { repo, move } = await withRatchet();

    await expect(ratchetFastForward(execGit, { ...move, ratchetRef: "refs/heads/main" })).rejects.toThrow("[ratchet-ref]");
    expect(await git(repo.bare, "rev-parse", "refs/heads/main")).toBe(repo.pin);
  });

  it("refuses when the remote ratchet is not at the head the winner was judged against", async () => {
    const { move, winner } = await withRatchet();

    await expect(ratchetFastForward(execGit, { ...move, from: winner })).rejects.toThrow("[ratchet-moved]");
  });
});
