import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRow } from "@titan-design/agent-dispatch";
import { fakeGitHub, fakeSha, githubPort } from "@titan-design/github";
import type { SourceTextLocator } from "@titan-design/session-read";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { defineWorkflow } from "../definition.js";
import { openFactoryHost, type FactoryHost } from "../host.js";
import type { ShepherdDeps, Verdict } from "./phases.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import { REVIEW_STEPS, reviewPhase, reviewRoutes, type ReviewerAgent, type ReviewerDispatch, type ReviewerReader } from "./review.js";
import { holdReviewerMigration, lineageMigration, shepherdMigration, shepherdStoreRef, sliceMigration } from "./store.js";
import { FIX_FIRST_STEP } from "./wake-brief.js";
import { WAKE_STEPS, wakePhase, wakeRoutes, type ImplementerAgents } from "./wake.js";

const REPO = "octo/demo";
const HEADS = [fakeSha("structural-1"), fakeSha("structural-2"), fakeSha("structural-3")] as const;
const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const SCRATCH = mkdtempSync(join(tmpdir(), "tp539-structural-"));
const CHECKOUT = join(SCRATCH, "demo");
mkdirSync(CHECKOUT, { recursive: true });
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

const FIRST_FINDINGS = ["Blocking items:", "1. The cache read fails open when the key is missing.", "2. The retry path swallows the timeout."].join("\n");
const SECOND_ITEMS = ["1. The config loader fails open on a parse error.", "2. The token check returns true when the header is absent.", "3. The quota guard allows a request when the counter is unreadable."];
const DEFECT_CLASS = ["Defect class: fail-open defaults. Every guard returns success when its input is missing.", "Boundary: the shared guard helper. Make it fail closed and every item above is covered."].join("\n");
const SECOND_FINDINGS = ["Blocking items:", ...SECOND_ITEMS, "", DEFECT_CLASS].join("\n");
const RE_REVIEW_ASK = "your review must include a section that starts with a line `Defect class:`";

const locatorIn = (nativeId: string) => ({ source: { conversation: { nativeId } } }) as unknown as SourceTextLocator;

function implementerRow(): AgentRow {
  const base = { name: "impl-a", agentId: "id-impl-a", state: "exited", presence: "exited", status: "finished", profile: "implementer", surface: "headless", model: null };
  return { ...base, cwd: "/work/impl-a", sessionId: "s-impl-a", transcriptPath: "/transcripts/impl-a.jsonl", transcriptExists: true, spawnedBy: null, account: null, generation: 1, teleportFrom: null };
}

/** A reviewer per head, each saying FIX_FIRST with the findings `findingsFor` gives that head. */
function fakeReviewers(clock: () => number, findingsFor: (head: string) => string) {
  const agents: ReviewerAgent[] = [];
  const briefs: string[] = [];
  const dispatch: ReviewerDispatch = {
    roster: async () => [...agents],
    spawn: async (name, brief) => void (briefs.push(brief), agents.push({ name, agentId: `id-${name}`, sessionId: `s-${name}`, presence: "live", spawnedBy: null, predecessor: null })),
    resume: async () => Promise.reject(new Error("no reviewer is resumed here")),
  };
  const reader: ReviewerReader = {
    read: async (input) => {
      const text = `${findingsFor(input.head)}\n\nVerdict: FIX_FIRST\nPR: ${input.repo}#${input.pr}\nHead: ${input.head}\n`;
      return [{ agentId: input.reviewerAgentId, sessionId: input.reviewerSessionId, writtenAt: clock() + 1, text, locator: locatorIn(input.reviewerSessionId) }];
    },
  };
  return { dispatch, reader, briefs };
}

/** An implementer that pushes the next head each time it is resumed. */
function fakeImplementer(pushNext: () => void) {
  const messages: string[] = [];
  const agents: ImplementerAgents = {
    roster: async () => [implementerRow()],
    resume: async (_name, message) => void (messages.push(message), pushNext()),
    message: async () => Promise.reject(new Error("the implementer is not live")),
    spawn: async () => Promise.reject(new Error("no successor is started here")),
  };
  return { agents, messages };
}

describe("a PR's second FIX_FIRST", () => {
  const hosts: FactoryHost[] = [];
  afterEach(() => hosts.splice(0).forEach((host) => host.close()));

  /** Reviews and sends back each head in turn, as shepherd-pr does on FIX_FIRST, with a new head between the reviews. */
  async function sendBackTwice(findingsFor: (head: string) => string) {
    const fake = fakeGitHub({ repo: REPO });
    fake.addPr({ headSha: HEADS[0], headRef: "feat/demo-fix" });
    let pushed = 0;
    let clock = T0;
    const store = shepherdStoreRef();
    const deps: ShepherdDeps = { port: githubPort(fake.wire), store, now: () => clock, sleep: async (ms) => void (clock += ms), pollMs: 1_000, agentChatBin: "/opt/bin/agent-chat" };
    const reviewers = fakeReviewers(() => clock, findingsFor);
    const implementer = fakeImplementer(() => fake.pushHead(1, HEADS[++pushed]!));
    const wiring = { agents: implementer.agents, readWarmth: async () => ({ lastEventAt: clock - 60_000, fill: 50_000 }), turnSince: async () => true, checkoutFor: () => CHECKOUT };
    const verdicts: Verdict[] = [];
    const run = async (ctx: Parameters<typeof reviewPhase>[0]) => {
      for (const [round, headSha] of HEADS.slice(0, 2).entries()) {
        const verdict = await reviewPhase(ctx, { repo: REPO, pr: 1, round, headSha });
        verdicts.push(verdict);
        await wakePhase(ctx, { kind: "review", repo: REPO, pr: 1, round, headSha, payload: verdict });
      }
    };
    const routes = Object.assign([...reviewRoutes(deps, { reader: reviewers.reader, dispatch: reviewers.dispatch, timeoutMs: 5_000 }), ...wakeRoutes(deps, wiring)], {
      database: { extraMigrations: [shepherdMigration(4), lineageMigration(5), sliceMigration(8), holdReviewerMigration(9)], bind: store.bind },
    });
    const host = openFactoryHost({ dbPath: ":memory:", workflows: [defineWorkflow({ name: "structural-test", steps: [...REVIEW_STEPS, ...WAKE_STEPS], run })], routes, gatePollMs: 5 });
    hosts.push(host);
    const runId = host.runtime.start("structural-test");
    store.get().register({ repo: REPO, pr: 1, runId, task: "demo task", implementer: "impl-a", policy: { ...OWNER_GATE_POLICY, fixer: true, seat: "demo-seat" } });
    const done = await host.runtime.wait(runId);
    const counted = Object.values(host.runtime.status(runId)!.stepResults).filter((result) => result.stepId === FIX_FIRST_STEP);
    return { status: done.status, verdicts, reviewerBriefs: reviewers.briefs, fixerBriefs: implementer.messages, counted: counted.map((result) => (result.data as { result: unknown }).result) };
  }

  const findings = (head: string) => (head === HEADS[0] ? FIRST_FINDINGS : SECOND_FINDINGS);

  it("counts FIX_FIRST across heads, so the new head after the first does not reset the count", async () => {
    const { status, counted } = await sendBackTwice(findings);

    expect(status).toBe("completed");
    expect(counted).toMatchObject([
      { headSha: HEADS[0], fixFirst: 1 },
      { headSha: HEADS[1], fixFirst: 2 },
    ]);
  });

  it("asks the re-reviewer for the recurring defect class, and not the first reviewer", async () => {
    const { reviewerBriefs } = await sendBackTwice(findings);

    expect(reviewerBriefs).toHaveLength(2);
    expect(reviewerBriefs[0]).not.toContain(RE_REVIEW_ASK);
    expect(reviewerBriefs[1]).toContain("This PR already had one FIX_FIRST review");
    expect(reviewerBriefs[1]).toContain(RE_REVIEW_ASK);
  });

  it("gives the first FIX_FIRST the ordinary brief", async () => {
    const { fixerBriefs } = await sendBackTwice(findings);

    expect(fixerBriefs[0]).toContain(`An independent review of head ${HEADS[0]} returned FIX_FIRST. Its findings follow.`);
    expect(fixerBriefs[0]).not.toContain("structural pass");
    expect(fixerBriefs[0]).not.toContain("```defect class");
  });

  it("gives the second FIX_FIRST a structural brief with the reviewer's defect class and every blocking item verbatim", async () => {
    const { fixerBriefs } = await sendBackTwice(findings);

    const brief = fixerBriefs[1]!;
    expect(brief).toContain("returned FIX_FIRST, the 2nd on this PR, so this is a structural pass");
    expect(brief).toContain("fix the defect class at the one boundary where a single change covers every instance");
    expect(brief).toContain(`\`\`\`defect class\n${DEFECT_CLASS}\n\`\`\``);
    for (const item of SECOND_ITEMS) expect(brief).toContain(item);
  });

  it("still sends a structural brief when the re-reviewer ignores the section, and asks the fixer to name the class", async () => {
    const { verdicts, fixerBriefs } = await sendBackTwice((head) => (head === HEADS[0] ? FIRST_FINDINGS : ["Blocking items:", ...SECOND_ITEMS].join("\n")));

    expect(verdicts.map((verdict) => verdict.kind)).toEqual(["FIX_FIRST", "FIX_FIRST"]);
    expect(fixerBriefs[1]).toContain("so this is a structural pass");
    expect(fixerBriefs[1]).toContain("The reviewer named no defect class.");
    expect(fixerBriefs[1]).not.toContain("```defect class");
    for (const item of SECOND_ITEMS) expect(fixerBriefs[1]).toContain(item);
  });
});
