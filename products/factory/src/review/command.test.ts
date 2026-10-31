import type { PanelVerdict, ReviewTarget } from "@titan-design/review-panel";
import type { Resumed, ReviewOutcome } from "@titan-design/review-workflow";
import { partialFake } from "@titan-design/test-kit";
import { Command } from "commander";
import { describe, expect, it } from "vitest";
import type { CliIo, Verbs } from "../cli.js";
import { registerReview, runResolve, runReview, type CiWait } from "./command.js";
import type { ReviewMember, ReviewReport } from "./format.js";
import type { ReviewService } from "./service.js";

const HEAD = "a".repeat(40);
const MOVED = "c".repeat(40);
const verdict = partialFake<PanelVerdict>({ head: HEAD });
const members: ReviewMember[] = [
  { shape: "correctness", name: "rv-widgets-7-aaaaaaa", profile: "reviewer", dispatch: "started" },
  { shape: "adversary", name: "rv-widgets-7-aaaaaaa-adversary", profile: "fable-reviewer", dispatch: "started" },
];

/** A service whose reviews end in `outcomes`, one per call, the last repeated. */
function fakeService(outcomes: readonly ReviewOutcome[], resumed: Resumed[] = []) {
  const reviewed: ReviewTarget[] = [];
  const service: ReviewService = {
    headOf: async (_target, head) => head ?? HEAD,
    review: async (target): Promise<ReviewReport> => {
      reviewed.push(target);
      return { runId: `run-${reviewed.length}`, outcome: outcomes[Math.min(reviewed.length, outcomes.length) - 1]!, members };
    },
    resolve: async () => resumed,
    close: () => undefined,
  };
  return { service, reviewed };
}

function captured(): CliIo & { out: () => string } {
  let text = "";
  return { stdout: (chunk) => void (text += chunk), stderr: () => undefined, env: {}, out: () => text };
}

const noWait: CiWait = { pollMs: 1, deadlineMs: 1_000, now: () => 0, sleep: async () => undefined };
const needsFixer: ReviewOutcome = { kind: "needs-fixer", head: HEAD, fingerprint: "start-refused:profile:reviewer", failure: "start-refused:profile" };

describe("titan-factory review", () => {
  it("exits 0 on a MERGE", async () => {
    const { service } = fakeService([{ kind: "MERGE", head: HEAD, verdict }]);

    expect(await runReview(service, "acme/widgets#7", {}, captured())).toBe(0);
  });

  it.each<ReviewOutcome>([{ kind: "FIX_FIRST", head: HEAD, verdict }, { kind: "needs-update", head: HEAD }, needsFixer])("exits non-zero on $kind", async (outcome) => {
    const { service } = fakeService([outcome]);

    expect(await runReview(service, "acme/widgets#7", {}, captured())).not.toBe(0);
  });

  it("prints needs-update as an action for the author and reviews nothing more", async () => {
    const { service, reviewed } = fakeService([{ kind: "needs-update", head: HEAD }]);
    const io = captured();

    await runReview(service, "acme/widgets#7", { waitCi: true }, io, noWait);

    expect([io.out().split("\n")[0], io.out().includes("does not update"), reviewed.length]).toEqual(["Outcome: needs-update", true, 1]);
  });

  it("prints one JSON object with the outcome, members and fingerprint under --json", async () => {
    const { service } = fakeService([needsFixer]);
    const io = captured();

    await runReview(service, "acme/widgets#7", { json: true }, io);

    const lines = io.out().trimEnd().split("\n");
    expect([lines.length, JSON.parse(lines[0]!)]).toEqual([1, expect.objectContaining({ outcome: "needs-fixer", fingerprint: "start-refused:profile:reviewer", members })]);
  });

  it("follows a moved head once under --wait-ci and waits out pending CI there", async () => {
    const { service, reviewed } = fakeService([
      { kind: "head-moved", head: HEAD, current: MOVED },
      { kind: "ci-not-green", head: MOVED, ci: "pending" },
      { kind: "MERGE", head: MOVED, verdict },
    ]);

    const code = await runReview(service, "acme/widgets#7", { waitCi: true }, captured(), noWait);

    expect([code, reviewed.map((target) => target.head)]).toEqual([0, [HEAD, MOVED, MOVED]]);
  });

  it("keeps a head pinned with --head even when the PR moved on", async () => {
    const { service, reviewed } = fakeService([{ kind: "head-moved", head: HEAD, current: MOVED }]);

    const code = await runReview(service, "acme/widgets#7", { head: HEAD, waitCi: true }, captured(), noWait);

    expect([code, reviewed.length]).toEqual([1, 1]);
  });
});

describe("titan-factory review resolve", () => {
  const run = { runId: "run-1", target: { repo: "acme/widgets", pr: 7, head: HEAD }, fingerprint: needsFixer.fingerprint, failure: needsFixer.failure };

  it("exits 0 only when every resumed run merges", async () => {
    const merged = fakeService([], [{ run, outcome: { kind: "MERGE", head: HEAD, verdict } }]).service;
    const failed = fakeService([], [{ run, error: "gh: 502" }]).service;

    expect([await runResolve(merged, run.fingerprint, {}, captured()), await runResolve(failed, run.fingerprint, {}, captured())]).toEqual([0, 1]);
  });
});

describe("registerReview", () => {
  async function parse(argv: string[], service: ReviewService): Promise<number> {
    let code = -1;
    const program = new Command().exitOverride();
    const verbs = partialFake<Verbs>({ io: captured(), dbPath: () => "/state/factory.sqlite3", setExit: (value: number) => void (code = value) });
    registerReview(program, verbs, () => service);
    await program.parseAsync(argv, { from: "user" });
    return code;
  }

  it("sends `review resolve <fingerprint>` to the resolve verb, not to a review of a PR", async () => {
    const { service, reviewed } = fakeService([{ kind: "MERGE", head: HEAD, verdict }]);

    const code = await parse(["review", "resolve", needsFixer.fingerprint], service);

    expect([code, reviewed.length]).toEqual([0, 0]);
  });

  it("reviews the PR a bare `review owner/repo#N` names", async () => {
    const { service, reviewed } = fakeService([{ kind: "MERGE", head: HEAD, verdict }]);

    await parse(["review", "acme/widgets#7"], service);

    expect(reviewed).toEqual([{ repo: "acme/widgets", pr: 7, head: HEAD }]);
  });
});
