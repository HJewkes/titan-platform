import { describe, expect, it } from "vitest";
import { runL0, type L0Result } from "./eval-l0.js";
import { beatClaims, claimFindings, claimText, claimsCheck, claimsCheckWith, findingLine, type GatheredFact } from "./lint-claims.js";
import type { ScriptV1 } from "./script-schema.js";
import { tour, withBeat } from "./voice-flow-fixtures.test-helpers.js";

const FACTS: GatheredFact[] = [
  { id: "pr/acme/parcel-desk#41/opened", kind: "pull-request", change: "opened", title: "Hold scans until the ledger answers" },
  { id: "pr/acme/parcel-desk#42/opened", kind: "pull-request", change: "opened", title: "Print refusals on the courier slip" },
  { id: "pr/acme/parcel-desk#40/merged", kind: "pull-request", change: "merged", title: "Add the ledger row cache" },
  { id: "pr/acme/label-kit#7/opened", kind: "pull-request", change: "opened", title: "Wider label margins" },
  { id: "task/PD-310/opened", kind: "task", change: "opened", title: "PD-310: refuse stale labels" },
  { id: "stats/desk", kind: "stats", text: "the desk printed 128 labels" },
];

const OPEN_PRS = ["pr/acme/parcel-desk#41/opened", "pr/acme/parcel-desk#42/opened", "pr/acme/parcel-desk#40/merged"];

const scriptSaying = (spoken: string, fact_ids: string[] = OPEN_PRS, visual: Record<string, unknown> = {}): ScriptV1 =>
  tour(withBeat("w2", { spoken, extra: { fact_ids, visual: { assertion: "The desk holds each scan", job: "artifact-filling", ...visual } } }));

const claimsRow = (script: ScriptV1, facts?: GatheredFact[]): L0Result =>
  runL0(script, undefined, [claimsCheckWith(facts)]).find((row) => row.check_id === "Q-E20")!;

describe("Q-E20 claims match the gathered facts", () => {
  it("passes a spoken count that equals the cited facts it counts", () => {
    const script = scriptSaying("So two pull requests are open on the desk, and one merged.");

    const row = claimsRow(script, FACTS);

    expect(row).toMatchObject({ severity: "error", pass: true, value: 0, detail_beats: [] });
  });

  it("fails a wrong count and names the facts it counted", () => {
    const script = scriptSaying("So three open PRs wait on the desk.");

    const findings = claimFindings(script, FACTS);

    expect(claimsRow(script, FACTS)).toMatchObject({ pass: false, value: 1, detail_beats: ["w2"] });
    expect(findings).toEqual([
      { beat: "w2", claim: "3 open PRs", nearest: expect.stringContaining("count 2 (pull request, open): pr/acme/parcel-desk#41/opened, pr/acme/parcel-desk#42/opened") },
    ]);
  });

  it("passes a count a cited fact holds as a value", () => {
    const script = scriptSaying("The desk printed 128 labels today, and every one passed the ledger.", ["stats/desk"]);

    expect(claimFindings(script, FACTS)).toEqual([]);
  });

  it("fails a pull request no fact names and points at the nearest one", () => {
    const script = scriptSaying("So pull request forty-three holds each scan until the ledger answers.");

    const [finding] = claimFindings(script, FACTS);

    expect(finding).toEqual({ beat: "w2", claim: "PR 43", nearest: "nearest gathered pull request is in pr/acme/parcel-desk#42/opened" });
    expect(findingLine(finding!)).toBe('w2 "PR 43" (nearest gathered pull request is in pr/acme/parcel-desk#42/opened)');
  });

  it("reads a short repo ref against the repo it abbreviates", () => {
    const known = scriptSaying("So ld#7 and parcel-desk#41 both touch the label.");
    const wrongRepo = scriptSaying("So parcel-desk#7 touches the label.");

    expect(claimFindings(tour(withBeat("w2", { spoken: "So label-kit#7 touches the label." })), FACTS)).toEqual([]);
    expect(claimFindings(known, FACTS).map((f) => f.claim)).toEqual(["ld#7"]);
    expect(claimFindings(wrongRepo, FACTS)).toEqual([{ beat: "w2", claim: "parcel-desk#7", nearest: "nearest gathered pull request is in pr/acme/parcel-desk#40/merged" }]);
  });

  it("checks a task id spelled out in the voice and an unknown one on screen", () => {
    const script = scriptSaying("So PD-three hundred ten refuses stale labels at the desk.", OPEN_PRS, { labels: ["PD-311"] });

    expect(claimFindings(script, FACTS)).toEqual([{ beat: "w2", claim: "PD-311", nearest: "nearest gathered task is in task/PD-310/opened" }]);
  });

  it("ignores ordinals, durations, years, indexes and a pronoun one", () => {
    const script = scriptSaying("Since 2024 merged PRs held, the 2nd pass took 90 seconds, chapter 3 merged it all, and no one open waited.");

    expect(beatClaims(script.beats.find((b) => b.id === "w2")!)).toEqual([]);
    expect(claimsRow(script, FACTS).pass).toBe(true);
  });

  it("backs a pull request said in pairs by the fact that names it", () => {
    const facts: GatheredFact[] = [{ id: "pr/acme/parcel-desk#2339/opened", kind: "pull-request", change: "opened", title: "Hold scans" }];
    const script = scriptSaying("So pull request twenty-three thirty-nine holds scans.", facts.map((f) => f.id));

    expect(claimFindings(script, facts)).toEqual([]);
  });

  it("still refuses a pair that neither reading backs", () => {
    const facts: GatheredFact[] = [{ id: "pr/acme/parcel-desk#2340/opened", kind: "pull-request", change: "opened", title: "Hold scans" }];
    const script = scriptSaying("So pull request twenty-three thirty-nine holds scans.", facts.map((f) => f.id));

    expect(claimFindings(script, facts).map((f) => f.beat)).toEqual(["w2"]);
  });

  it("reports a passing warning row, not an error, when no facts were gathered", () => {
    const script = scriptSaying("So three open PRs wait on the desk.");

    expect(claimsRow(script)).toMatchObject({ check_id: "Q-E20", severity: "warning", pass: true, value: 0 });
    expect(claimsRow(script, [])).toMatchObject({ severity: "warning", pass: true });
    expect(runL0(script, undefined, [claimsCheck])[0]).toMatchObject({ severity: "warning", pass: true });
  });
});

describe("claimText", () => {
  it("writes spelled numbers in digits, inside an id too, and keeps a bare 'and'", () => {
    expect(claimText("PD-four thousand one hundred three and pull request two thousand three hundred nineteen")).toBe("PD-4103 and pull request 2319");
    expect(claimText("one hundred and five, twenty four, one two")).toBe("105, 24, 1 2");
    expect(claimText("[seventy-nine](=seventy nine) merged")).toBe("79 merged");
  });

  it("reads numbers said in pairs as one value only when asked", () => {
    expect(claimText("five thirty-one and twenty-three thirty-nine", true)).toBe("531 and 2339");
    expect(claimText("one two, five and thirty-one", true)).toBe("1 2, 5 and 31");
    expect(claimText("five thirty-one")).toBe("5 31");
  });
});
