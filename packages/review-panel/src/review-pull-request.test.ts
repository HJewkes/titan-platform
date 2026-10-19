import { readFileSync } from "node:fs";
import { lineSourceFromTexts } from "@titan-design/evidence";
import type { SourceTextLocator } from "@titan-design/session-read";
import { partialFake } from "@titan-design/test-kit";
import { describe, expect, it } from "vitest";
import { DEFAULT_PANEL_POLICY, DEFAULT_PANEL_TABLE } from "./plan.js";
import type { ReviewerAgent, ReviewerMessage } from "./ports.js";
import { memberName, reviewPullRequest, type ReviewPorts, type ReviewRequest } from "./review-pull-request.js";
import type { PrFacts } from "./types.js";

const HEAD = "c".repeat(40);
const TARGET = { repo: "octo/demo", pr: 7, head: HEAD };
const OPTS = { pollMs: 1_000, startDeadlineMs: 5_000, verdictDeadlineMs: 10_000 };
const STANDARD: PrFacts = {
  ...TARGET,
  base: "b".repeat(40),
  kind: "feature",
  changedFiles: [
    { path: "packages/x/src/gate.ts", additions: 5, deletions: 1 },
    { path: "packages/x/src/gate.test.ts", additions: 9, deletions: 0 },
  ],
};
const G10: PrFacts = { ...STANDARD, authorityTouch: true };
const PANEL = { ...DEFAULT_PANEL_POLICY, panel: DEFAULT_PANEL_TABLE };
const request = (facts: PrFacts, policy = DEFAULT_PANEL_POLICY): ReviewRequest => ({ facts, policy, brief: { checkoutRoot: "/tmp/reviews" }, source: lineSourceFromTexts({}) });

type Reply = Pick<ReviewerMessage, "text" | "synthetic"> | undefined;
/** What the reviewer under `name` has written last, before or after its correction. */
type Script = (name: string, resumed: boolean) => Reply;

const verdict = (word: "MERGE" | "FIX_FIRST"): Reply => ({ text: `Read packages/x/src/gate.ts.\n\nVerdict: ${word}\nPR: octo/demo#7\nHead: ${HEAD}\n` });
const merge: Script = () => verdict("MERGE");
const silent: Script = () => undefined;
const locatorFor = (sessionId: string) =>
  partialFake<SourceTextLocator>({ source: partialFake<SourceTextLocator["source"]>({ conversation: partialFake<SourceTextLocator["source"]["conversation"]>({ nativeId: sessionId }) }) });

/** One agent-chat broker and one clock: a spawn adds a started row, and a reviewer's reply is written just after its spawn or resume. */
function fakeWorld(script: Script, refused: readonly string[] = []) {
  const world = { now: 1_000_000, rows: [] as ReviewerAgent[], tried: [] as string[], spawns: [] as { name: string; profile?: string; at: number }[], resumes: [] as { name: string; brief: string }[] };
  const sent = new Map<string, { at: number; resumed: boolean }>();
  const read = async (agentId: string): Promise<ReviewerMessage[]> => {
    const row = world.rows.find((r) => r.agentId === agentId);
    const last = row && sent.get(row.name);
    const reply = row && last && script(row.name, last.resumed);
    return row && last && reply ? [{ agentId, sessionId: row.sessionId, writtenAt: last.at, locator: locatorFor(row.sessionId), ...reply }] : [];
  };
  const ports: ReviewPorts = {
    headroom: async () => ({ opus: true }),
    clock: { now: () => world.now, sleep: async (ms) => void (world.now += ms) },
    reader: { read: (input) => read(input.reviewerAgentId) },
    dispatch: {
      roster: async () => world.rows,
      spawn: async (name, _brief, _target, facts) => {
        world.tried.push(facts?.profile ?? "");
        if (refused.includes(facts?.profile ?? "")) throw new Error("spawn refused");
        world.spawns.push({ name, at: world.now, ...(facts?.profile && { profile: facts.profile }) });
        world.rows.push({ name, agentId: `agent-${name}`, sessionId: `session-${name}`, presence: "live", spawnedBy: null, ...(facts?.profile && { profile: facts.profile }) });
        sent.set(name, { at: world.now + 1, resumed: false });
      },
      resume: async (name, brief) => {
        world.resumes.push({ name, brief });
        sent.set(name, { at: world.now + 1, resumed: true });
      },
    },
  };
  return { world, ports };
}

describe("reviewPullRequest", () => {
  it("passes the brief's fix-proof waiver to the aggregate, which merges only when the waiver names the head", async () => {
    const vacuous = (fixProofWaivedAt: string): ReviewRequest => ({ ...request(STANDARD), brief: { checkoutRoot: "/tmp/reviews", fixProof: "vacuous", fixProofWaivedAt } });

    const waived = await reviewPullRequest(vacuous(HEAD), fakeWorld(merge).ports, OPTS);
    const stale = await reviewPullRequest(vacuous("d".repeat(40)), fakeWorld(merge).ports, OPTS);

    expect(waived.outcome).toBe("MERGE");
    expect(stale.outcome).toBe("no-verdict");
  });

  it("spawns the single correctness member under its derived name and returns its MERGE", async () => {
    const { world, ports } = fakeWorld(merge);

    const result = await reviewPullRequest(request(STANDARD), ports, OPTS);

    expect(world.spawns).toEqual([{ name: "rp-octo-demo-7-cccccccc-correctness", profile: "reviewer", at: 1_000_000 }]);
    expect(result).toMatchObject({ outcome: "MERGE", head: HEAD, degraded: [], satisfiesG10: false });
  });

  it("spawns a g10 pair in parallel, opus correctness beside a sonnet adversary, and satisfies G10 on two MERGEs", async () => {
    const { world, ports } = fakeWorld(merge);

    const result = await reviewPullRequest(request(G10, PANEL), ports, OPTS);

    expect(world.spawns).toEqual([
      { name: memberName(TARGET, "correctness"), profile: "bd-reviewer", at: 1_000_000 },
      { name: memberName(TARGET, "adversary"), profile: "reviewer", at: 1_000_000 },
    ]);
    expect(result).toMatchObject({ outcome: "MERGE", satisfiesG10: true });
  });

  it("retries a refused opus spawn once at sonnet and marks the member degraded, so G10 is not satisfied, even on a repeat", async () => {
    const { world, ports } = fakeWorld(merge, ["bd-reviewer"]);

    const result = await reviewPullRequest(request(G10, PANEL), ports, OPTS);
    const repeat = await reviewPullRequest(request(G10, PANEL), ports, OPTS);

    expect(world.tried).toEqual(["bd-reviewer", "reviewer", "reviewer"]);
    expect(world.spawns.find((s) => s.name === memberName(TARGET, "correctness"))?.profile).toBe("reviewer");
    expect(result).toMatchObject({ outcome: "MERGE", degraded: ["correctness"], satisfiesG10: false });
    expect(repeat).toEqual(result);
  });

  it("gives a member the dispatch refuses at every profile no verdict, with no fresh retry", async () => {
    const { world, ports } = fakeWorld(merge, ["reviewer"]);

    const result = await reviewPullRequest(request(STANDARD), ports, OPTS);

    expect(world.tried).toEqual(["reviewer"]);
    expect(result.outcome).toBe("no-verdict");
  });

  it("retries a silent member once under a fresh -r2 name, then reports a timeout", async () => {
    const { world, ports } = fakeWorld(silent);

    const result = await reviewPullRequest(request(STANDARD), ports, OPTS);

    expect(world.spawns.map((s) => s.name)).toEqual(["rp-octo-demo-7-cccccccc-correctness", "rp-octo-demo-7-cccccccc-correctness-r2"]);
    expect(result.outcome).toBe("timeout");
  });

  it("counts the fresh reviewer's verdict when the first one stayed silent", async () => {
    const { ports } = fakeWorld((name) => (name.endsWith("-r2") ? verdict("FIX_FIRST") : undefined));

    const result = await reviewPullRequest(request(STANDARD), ports, OPTS);

    expect(result).toMatchObject({ outcome: "FIX_FIRST", dissent: ["correctness"] });
  });

  it("corrects a malformed verdict once by resuming the same reviewer, and accepts its corrected reply", async () => {
    const { world, ports } = fakeWorld((_name, resumed) => (resumed ? verdict("MERGE") : { text: "Looks fine to me." }));

    const result = await reviewPullRequest(request(STANDARD), ports, OPTS);

    expect(world.spawns).toHaveLength(1);
    expect(world.resumes).toHaveLength(1);
    expect(world.resumes[0]?.brief).toContain(`PR: octo/demo#7\nHead: ${HEAD}`);
    expect(result.outcome).toBe("MERGE");
  });

  it("corrects a MERGE whose CI-policy line is prose once, and accepts its corrected unchanged MERGE", async () => {
    const prose: Reply = { text: `${verdict("MERGE")?.text}CI-policy: no .github/ files changed and no required check was dropped, renamed or skipped.` };
    const { world, ports } = fakeWorld((_name, resumed) => (resumed ? { text: `${verdict("MERGE")?.text}CI-policy: unchanged` } : prose));

    const result = await reviewPullRequest(request(STANDARD), ports, OPTS);

    expect(world.spawns).toHaveLength(1);
    expect(world.resumes).toHaveLength(1);
    expect(world.resumes[0]?.brief).toContain("its CI-policy line held more than the exact form");
    expect(result.outcome).toBe("MERGE");
  });

  it("allows one correction per member: a still-malformed reply goes to a fresh reviewer that gets none", async () => {
    const { world, ports } = fakeWorld(() => ({ text: "No block here." }));

    const result = await reviewPullRequest(request(STANDARD), ports, OPTS);

    expect(world.resumes.map((r) => r.name)).toEqual([memberName(TARGET, "correctness")]);
    expect(world.spawns.map((s) => s.name)).toEqual([memberName(TARGET, "correctness"), memberName(TARGET, "correctness", 2)]);
    expect(result.outcome).toBe("no-verdict");
  });

  it("neither corrects nor retries a member stopped by the account usage limit", async () => {
    const limit: Reply = { text: "You've hit your weekly limit · resets Oct 10 at 6pm (America/Denver)", synthetic: { apiError: "rate_limit", resetsAt: null } };
    const { world, ports } = fakeWorld(() => limit);

    const result = await reviewPullRequest(request(STANDARD), ports, OPTS);

    expect(world.spawns).toHaveLength(1);
    expect(world.resumes).toHaveLength(0);
    expect(result.outcome).toBe("no-verdict");
  });

  it("reuses the roster rows on a repeat call with the same input and spawns nothing", async () => {
    const { world, ports } = fakeWorld(merge);
    const first = await reviewPullRequest(request(G10, PANEL), ports, OPTS);
    const spawned = world.spawns.length;

    const repeat = await reviewPullRequest(request(G10, PANEL), ports, OPTS);

    expect(world.spawns).toHaveLength(spawned);
    expect(repeat).toEqual(first);
  });

  it("imports nothing from agent-dispatch, workflow or a product", () => {
    const text = readFileSync(new URL("./review-pull-request.ts", import.meta.url), "utf8");
    const specifiers = [...text.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);

    expect(specifiers.filter((s) => /agent-dispatch|workflow|products\//.test(s ?? ""))).toEqual([]);
    expect(specifiers.every((s) => s?.startsWith("./") || s === "@titan-design/evidence")).toBe(true);
  });
});

describe("memberName", () => {
  it("is a pure function of repo, pr, head and shape, with -r2 for the fresh retry", () => {
    expect(memberName(TARGET, "adversary")).toBe("rp-octo-demo-7-cccccccc-adversary");
    expect(memberName(TARGET, "adversary", 2)).toBe("rp-octo-demo-7-cccccccc-adversary-r2");
  });
});
