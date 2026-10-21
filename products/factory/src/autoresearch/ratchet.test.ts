import { afterEach, describe, expect, it } from "vitest";
import { execGit, ratchetFastForward } from "./ratchet.js";
import { fixtureRepo, git, removeFixture, type FixtureRepo } from "./test-support/fake-ports.js";

const repos: FixtureRepo[] = [];
afterEach(() => repos.splice(0).forEach(removeFixture));

const POLICY = { sigma: 0, base_cc: 0, accepted_tasks: 1, mechanisms: {} };
const REF = "refs/heads/autoresearch/fixture/run-1";

async function withRatchet() {
  const repo = await fixtureRepo(POLICY);
  repos.push(repo);
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
