import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeGitHub, githubPort, successRun } from "@titan-design/github";
import { GateResolverRefused, type GateResolver } from "@titan-design/hitl";
import { gitIn, seedRepo, withHistory } from "@titan-design/test-kit/git";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { readCoordinatorEvidence, type EvidenceSources } from "./coordinator-evidence-read.js";
import { defineWorkflow } from "./definition.js";
import { approveMergeDecision } from "./gate-brief.js";
import { resolveGate } from "./gate-resolve.js";
import { openFactoryHost, type FactoryHost } from "./host.js";
import { readMergeUpChain } from "./merge-up-chain.js";
import { readPath } from "./narrow.js";
import { fakeOwnerHelper } from "./test-support/owner-edges.js";

const REPO = "acme/widgets";
const REASON = "the authority policy did not allow an automated merge: CI-policy weakened: other";
const AGENT_SHELL = { AGENT_CHAT_AGENT_ID: "agent-1", AGENT_CHAT_NAME: "tc-synthetic" };
const NOW = Date.parse("2026-11-06T21:00:00Z");
const Heads = z.array(z.string());

/** A stand-in for land: asks to merge at the first head, and once that gate is answered or cancelled, at the second. */
const landTwice = defineWorkflow({
  name: "shepherd-pr",
  steps: [{ id: "approve-merge", kind: "assisted" }],
  run: async (ctx) => {
    for (const head of Heads.parse(JSON.parse(ctx.param("heads")!))) {
      const prompt = `Merge PR #1 in ${REPO} at head ${head} into main? CI is green. Policy shepherd-merge-guard/ci-policy-weakened: ${REASON}`;
      await ctx.assisted("approve-merge", prompt, { ...approveMergeDecision({ repo: REPO, pr: 1, headSha: head, reason: REASON, reviewedMerge: true }), recordCancel: true });
    }
  },
});

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

interface World {
  host: FactoryHost;
  runId: string;
  origin: string;
  sources: EvidenceSources;
}

/** An origin repo with the approved head on `feature`, and `ups` clean merge-ups of main on top of it. */
function repoWithMergeUps(root: string, ups: number): { origin: string; approved: string; head: string } {
  const origin = join(root, "origin");
  const git = gitIn(origin);
  seedRepo(origin, {});
  git("config", "uploadpack.allowAnySHA1InWant", "true");
  const approved = withHistory(origin, [
    { files: { "a.txt": "a0\n" }, message: "seed" },
    { branch: "feature", from: ":1", files: { "a.txt": "a1\n" }, message: "pr change" },
  ])[1]!;
  for (let n = 1; n <= ups; n += 1) {
    withHistory(origin, [{ files: { [`main-${n}.txt`]: `m${n}\n` }, message: `main ${n}` }]);
    git("checkout", "-q", "feature");
    git("merge", "-q", "--no-ff", "--no-edit", "main");
  }
  return { origin, approved, head: git("rev-parse", "feature") };
}

async function pausedAt(heads: readonly string[], origin: string, root: string): Promise<World> {
  const host = openFactoryHost({ dbPath: join(root, "factory.sqlite3"), workflows: [landTwice], routes: [], gatePollMs: 10 });
  cleanups.push(() => host.close());
  const runId = host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", heads: JSON.stringify(heads) });
  await vi.waitFor(() => expect(host.runtime.status(runId)?.status).toBe("paused"));
  const gh = fakeGitHub({ repo: REPO });
  gh.addPr({ headSha: heads.at(-1)! });
  gh.setRuns(heads.at(-1)!, [successRun("validate", 11), successRun("dag-check", 12)]);
  const sources: EvidenceSources = {
    port: githubPort(gh.wire),
    registration: () => undefined,
    frozen: () => false,
    now: () => NOW,
    mergeUpChain: (input) => readMergeUpChain(input, { stateDir: join(root, "state"), remote: () => origin }),
  };
  return { host, runId, origin, sources };
}

function world(ups: number, extra?: (git: (...args: string[]) => string) => void): { root: string; origin: string; approved: string; head: string } {
  const root = mkdtempSync(join(tmpdir(), "merge-up-resolve-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const repo = repoWithMergeUps(root, ups);
  if (!extra) return { root, ...repo };
  extra(gitIn(repo.origin));
  return { root, ...repo, head: gitIn(repo.origin)("rev-parse", "feature") };
}

async function resolve(w: World, payload: object, env: NodeJS.ProcessEnv) {
  let out = "";
  let err = "";
  const io = { stdout: (t: string) => void (out += t), stderr: (t: string) => void (err += t), env };
  const code = await resolveGate(w.host, io, w.runId, "approve-merge", JSON.stringify(payload), w.sources).catch((error: Error) => ((err += error.message), 1));
  return { code, out, err };
}

/** The owner answers merge at the approved head from their own terminal; the run then asks again at the moved head. */
async function ownerApproves(w: World, approved: string): Promise<string> {
  expect((await resolve(w, { decision: "merge", headSha: approved }, {})).code).toBe(0);
  await vi.waitFor(() => expect(w.host.pendingGates().map(({ gate }) => gate.id)).toEqual([`${w.runId}/approve-merge:1`]));
  return `${w.runId}/approve-merge:1`;
}

describe("coordinator resolve of a land gate whose head moved only by clean merge-ups (TP-4791)", { timeout: 60_000 }, () => {
  it.each([1, 4])("resolves on merge-up-approval evidence after %i merge-up(s) since the owner's merge answer", async (ups) => {
    const { root, origin, approved, head } = world(ups);
    const w = await pausedAt([approved, head], origin, root);
    const gateId = await ownerApproves(w, approved);

    const result = await resolve(w, { decision: "merge", headSha: head }, AGENT_SHELL);

    expect(result).toMatchObject({ code: 0, out: expect.stringContaining("as coordinator tc-synthetic on merge-up-approval evidence") });
    const gate = w.host.gates.get(gateId);
    expect(gate).toMatchObject({ status: "resolved", resolvedBy: { class: "coordinator", id: "tc-synthetic" } });
    expect(gate?.resolvedEvidence).toMatchObject({ kind: "merge-up-approval", approval: { gateId: `${w.runId}/approve-merge`, head: approved, resolverClass: "owner-terminal" } });
    expect(readPath(gate?.resolvedEvidence, "mergeUps")).toHaveLength(ups);
  });

  it("refuses with the reason when a plain commit follows the merge-ups", async () => {
    const { root, origin, approved, head } = world(2, (git) => {
      writeFileSync(join(git("rev-parse", "--show-toplevel"), "a.txt"), "a2\n");
      git("commit", "-q", "-am", "fix");
    });
    const w = await pausedAt([approved, head], origin, root);
    const gateId = await ownerApproves(w, approved);
    fakeOwnerHelper(undefined);

    const result = await resolve(w, { decision: "merge", headSha: head }, AGENT_SHELL);

    expect(result.code).toBe(1);
    expect(result.err).toContain(`no merge-up approval: ${head} has 1 parent(s), not the two of a merge-up`);
    expect(w.host.gates.get(gateId)?.status).toBe("pending");
  });

  it("refuses when the earlier gate was cancelled rather than answered by the owner", async () => {
    const { root, origin, approved, head } = world(1);
    const w = await pausedAt([approved, head], origin, root);
    w.host.gates.cancel(`${w.runId}/approve-merge`, "superseded: the pull request moved");
    await vi.waitFor(() => expect(w.host.gates.get(`${w.runId}/approve-merge:1`)?.status).toBe("pending"));
    fakeOwnerHelper(undefined);

    const result = await resolve(w, { decision: "merge", headSha: head }, AGENT_SHELL);

    expect(result.err).toContain("no merge-up approval: no owner merge answer on an earlier land gate of this run");
    expect(w.host.gates.get(`${w.runId}/approve-merge:1`)?.status).toBe("pending");
  });

  it("lets the store refuse the same evidence from any class but coordinator", async () => {
    const { root, origin, approved, head } = world(1);
    const w = await pausedAt([approved, head], origin, root);
    const gateId = await ownerApproves(w, approved);
    const coordinator: GateResolver = { class: "coordinator", id: "tc-synthetic", channel: "factory-cli" };
    const payload = { decision: "merge", headSha: head };
    const evidence = await readCoordinatorEvidence(w.host, w.sources, gateId, payload, coordinator);

    expect(evidence?.kind).toBe("merge-up-approval");
    expect(() => w.host.gates.resolve(gateId, payload, { ...coordinator, class: "automation" }, evidence)).toThrow(GateResolverRefused);
    expect(w.host.gates.get(gateId)?.status).toBe("pending");
  });
});
