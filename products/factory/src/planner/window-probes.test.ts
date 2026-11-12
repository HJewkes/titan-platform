import type { GateRecord } from "@titan-design/hitl";
import { describe, expect, it } from "vitest";
import { runCli } from "../cli.js";
import type { CliIo } from "../cli-types.js";
import { factoryWorkflows } from "../workflows.js";
import type { PlannerRun } from "./inputs.js";
import { readPriorWindow } from "./prior-window.js";
import type { MergedPr, RedRun, RoundAnswer, WindowSources } from "./window-probes.js";

const SINCE = "2026-01-02T03:00:00.000Z";
const BEFORE = "2026-01-02T02:59:59.000Z";
const AFTER = "2026-01-02T03:30:00.000Z";
const REPO = "example-org/example-repo";

const BLANK_GATE: GateRecord = {
  id: "",
  prompt: "",
  schema: undefined,
  status: "pending",
  payload: undefined,
  reason: undefined,
  createdAt: BEFORE,
  resolvedAt: undefined,
  expiresAt: undefined,
  resolvedBy: undefined,
  resolvedEvidence: undefined,
  rule: undefined,
  summary: undefined,
  evidenceRef: undefined,
  questions: undefined,
};

const gate = (fields: Partial<GateRecord> & Pick<GateRecord, "id">): GateRecord => ({ ...BLANK_GATE, ...fields });

interface Window {
  merged?: MergedPr[];
  red?: RedRun[];
  gates?: GateRecord[];
  rounds?: RoundAnswer[];
  failGates?: boolean;
}

function sources(window: Window = {}): WindowSources {
  return {
    github: { mergedPrs: async () => window.merged ?? [], redMainRuns: async () => window.red ?? [] },
    repos: [REPO],
    gates: () => {
      if (window.failGates) throw new Error("unable to open database file");
      return window.gates ?? [];
    },
    rounds: async () => window.rounds ?? [],
  };
}

async function probe(argv: string[], window: Window = {}) {
  let stdout = "";
  let stderr = "";
  const io: CliIo = { stdout: (text) => void (stdout += text), stderr: (text) => void (stderr += text), env: {} };
  const code = await runCli(["planner", "probe", ...argv], io, { workflows: factoryWorkflows, routes: [], planner: { windowSources: () => sources(window) } });
  return { code, stdout, stderr };
}

const PRIOR_WINDOW = {
  merges: ["titan-factory", "planner", "probe", "merges", "--since", "{since}"],
  ownerContact: ["titan-factory", "planner", "probe", "owner-contact", "--since", "{since}"],
  newRed: ["titan-factory", "planner", "probe", "new-red", "--since", "{since}"],
};

/** The wake's view: each priorWindow command runs the real probe verb over the window's sources. */
const verdict = (window: Window) => {
  const run: PlannerRun = (_file, args) => probe(args.slice(2), window);
  return readPriorWindow(PRIOR_WINDOW, SINCE, run);
};

describe("planner prior window over the probe verbs", () => {
  it("empty window with all three probes empty skips", async () => {
    const quiet = { merged: [], gates: [gate({ id: "run-1/ci-failed", createdAt: BEFORE })], rounds: [{ id: "r1", submittedAt: BEFORE }] };
    expect(await verdict(quiet)).toEqual({ kind: "quiet", summary: "0 merges, 0 owner contact, 0 new red" });
  });

  it("one merge in the window runs the review", async () => {
    expect(await verdict({ merged: [{ number: 7, mergedAt: AFTER }] })).toEqual({ kind: "active" });
  });

  it("a probe read error runs the review", async () => {
    const result = await verdict({ failGates: true });
    expect(result).toEqual({ kind: "unknown", error: "ownerContact: exit 1: planner probe owner-contact: unable to open database file" });
  });
});

describe("titan-factory planner probe", () => {
  it("prints each merge in the window and drops one GitHub's search rounded in", async () => {
    const out = await probe(["merges", "--since", SINCE], { merged: [{ number: 7, mergedAt: AFTER }, { number: 6, mergedAt: BEFORE }] });
    expect(out).toEqual({ code: 0, stdout: `${REPO}#7 merged ${AFTER}\n`, stderr: "" });
  });

  it("counts a gate resolve and a console round answer as owner contact", async () => {
    const resolved = gate({ id: "run-2/approve-merge", status: "resolved", resolvedAt: AFTER });
    const stillOpen = gate({ id: "run-3/approve-merge", createdAt: AFTER });
    const out = await probe(["owner-contact", "--since", SINCE], { gates: [resolved, stillOpen], rounds: [{ id: "r9", submittedAt: AFTER }] });
    expect(out.stdout).toBe(`gate run-2/approve-merge resolved ${AFTER}\nround r9 answered ${AFTER}\n`);
  });

  it.each([
    ["invalid JSON", "feedback.json is not valid JSON"],
    ["schema mismatch", "feedback.json has no valid submittedAt field"],
    ["non-ISO submittedAt", "submittedAt is not an ISO time"],
  ])("reports a round undatable by %s with its own cause", async (_name, why) => {
    const out = await probe(["owner-contact", "--since", SINCE], { rounds: [{ id: "r8", submittedAt: undefined, why }] });
    expect(out.stdout).toBe(`round r8 answered at an unknown time: ${why}\n`);
  });

  it("reports a merge with an unparseable mergedAt as merged at an unknown time", async () => {
    const out = await probe(["merges", "--since", SINCE], { merged: [{ number: 5, mergedAt: "not-a-time" }] });
    expect(out.stdout).toBe(`${REPO}#5 merged at an unknown time\n`);
  });

  it("reports a resolved gate with no resolvedAt as resolved at an unknown time", async () => {
    const out = await probe(["owner-contact", "--since", SINCE], { gates: [gate({ id: "run-6/approve-merge", status: "resolved", resolvedAt: undefined })] });
    expect(out.stdout).toBe("gate run-6/approve-merge resolved at an unknown time\n");
  });

  it("reports a red run with an unparseable createdAt as failed at an unknown time", async () => {
    const out = await probe(["new-red", "--since", SINCE], { red: [{ id: 42, workflow: "CI", createdAt: "yesterday" }] });
    expect(out.stdout).toBe(`${REPO} main run 42 (CI) failed at an unknown time\n`);
  });

  it("reports a ci-failed gate with an unparseable createdAt as opened at an unknown time", async () => {
    const out = await probe(["new-red", "--since", SINCE], { gates: [gate({ id: "run-7/ci-failed:1", createdAt: "not-a-time" })] });
    expect(out.stdout).toBe("gate run-7/ci-failed:1 opened at an unknown time\n");
  });

  it("counts a red main run and a ci-failed gate opened in the window as new red", async () => {
    const red = [{ id: 41, workflow: "CI", createdAt: AFTER }];
    const gates = [gate({ id: "run-4/ci-failed:2", createdAt: AFTER }), gate({ id: "run-5/approve-merge", createdAt: AFTER })];
    const out = await probe(["new-red", "--since", SINCE], { red, gates });
    expect(out.stdout).toBe(`${REPO} main run 41 (CI) failed ${AFTER}\ngate run-4/ci-failed:2 opened ${AFTER}\n`);
  });

  it("asks gh for each --repo's merges since the window start and fails when gh does", async () => {
    const asked: string[][] = [];
    const gh: PlannerRun = async (_file, args) => {
      asked.push([...args]);
      return args.includes("other-org/other-repo") ? { code: 4, stdout: "", stderr: "gh: auth required" } : { code: 0, stdout: JSON.stringify([{ number: 3, mergedAt: AFTER }]), stderr: "" };
    };
    let stderr = "";
    const io: CliIo = { stdout: () => {}, stderr: (text) => void (stderr += text), env: {} };
    const code = await runCli(["planner", "probe", "merges", "--since", SINCE, "--repo", REPO, "--repo", "other-org/other-repo"], io, { workflows: factoryWorkflows, routes: [], planner: { run: gh } });
    expect(asked[0]).toEqual(["pr", "list", "--repo", REPO, "--state", "merged", "--search", `merged:>=${SINCE.replace(".000Z", "Z")}`, "--json", "number,mergedAt", "--limit", "100"]);
    expect(code).toBe(1);
    expect(stderr).toBe("planner probe merges: gh pr list: exit 4: gh: auth required\n");
  });

  it("refuses an unknown probe or a since that is not an ISO time", async () => {
    expect((await probe(["merged", "--since", SINCE])).code).toBe(2);
    expect((await probe(["merges", "--since", "yesterday"])).code).toBe(2);
  });

  it("refuses a since that has the ISO shape but names a day that does not exist", async () => {
    expect((await probe(["merges", "--since", "2026-02-30T00:00:00Z"])).code).toBe(2);
  });

  it("reports an event stamped with a day that does not exist as at an unknown time", async () => {
    const out = await probe(["merges", "--since", SINCE], { merged: [{ number: 7, mergedAt: "2026-02-30T00:00:00Z" }, { number: 8, mergedAt: AFTER }] });
    expect(out.stdout).toBe(`${REPO}#8 merged ${AFTER}\n${REPO}#7 merged at an unknown time\n`);
  });

  it("fails rather than printing nothing when no repo is configured", async () => {
    let stderr = "";
    const io: CliIo = { stdout: () => {}, stderr: (text) => void (stderr += text), env: {} };
    const noRepos = (): WindowSources => ({ ...sources(), repos: [] });
    const code = await runCli(["planner", "probe", "merges", "--since", SINCE], io, { workflows: factoryWorkflows, routes: [], planner: { windowSources: noRepos } });
    expect(code).toBe(1);
    expect(stderr).toMatch(/no repos/);
  });
});
