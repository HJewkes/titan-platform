import { describe, expect, it } from "vitest";
import { dailyWith, l0Row } from "./daily-script.test-helpers.js";
import { runL0, type L0Result } from "./eval-l0.js";
import { repairHint } from "./l0-repair-hints.js";
import { claimsCheckWith } from "./lint-claims.js";
import { flowCheck } from "./lint-flow.js";
import { headlineCheck } from "./lint-headline.js";
import { heteronymCheck } from "./lint-heteronyms.js";
import { ledgerCheck } from "./lint-ledger.js";
import { whyCheck } from "./lint-why.js";
import type { ScriptV1 } from "./script-schema.js";
import { GOOD_BEATS, tour, withBeat, type BeatSpec } from "./voice-flow-fixtures.test-helpers.js";

const failing = (script: ScriptV1, id: string): L0Result => {
  const row = runL0(script, undefined, [flowCheck, whyCheck, heteronymCheck, ledgerCheck, headlineCheck]).find((r) => r.check_id === id);
  expect(row?.pass, `${id} should fail`).toBe(false);
  return row!;
};

const hintFor = (script: ScriptV1, id: string): string | undefined => repairHint(failing(script, id), script);

describe("repair hints for rows whose value says too little", () => {
  it("Q-F4 names the thesis ref outside its slot and where it starts", () => {
    const script = tour(GOOD_BEATS, { thesis_refs: ["h1", "h2", "c1"] });

    expect(hintFor(script, "Q-F4")).toBe("the midpoint thesis ref h2 starts at 9 % of planned time; it must start between 35 % and 65 %");
  });

  it("Q-F4 names the early beat closest to voicing the mechanism and the words it never says", () => {
    const script = tour(GOOD_BEATS, { thesis_mechanism: "pallets ride a conveyor into the sorting hall at night" });

    expect(hintFor(script, "Q-F4")).toMatch(/^no beat before 20 % of planned time speaks 60 % of thesis_mechanism's content words \(closest: \w+, which never says pallet, .*conveyor/);
  });

  it("Q-F5 quotes the pivot form the check counts, and how many the draft has", () => {
    const script = tour(withBeat("w4", { spoken: "That is the whole job of the desk." }));

    expect(hintFor(script, "Q-F5")).toContain('has 0 (none) and needs exactly one');
    expect(hintFor(script, "Q-F5")).toContain('"Now, how does');
  });

  it("Q-F1 names the connective that opens too many linked beats", () => {
    const beats = GOOD_BEATS.map((s): BeatSpec => (["h2", "w2", "w3", "w4", "k2", "k3", "c2"].includes(s[0]) ? [s[0], s[1], s[2], `So ${s[3]}`, s[4]] : s));

    expect(hintFor(tour(beats), "Q-F1")).toMatch(/"so" opens \d+ of \d+ linked beats, past the 40 % one connective may carry/);
  });

  // Mutation: dropping connectorEdits' cap slice, or telling the beats to link by a shared word, leaves Q-F1 failing.
  it("Q-F1 names the connector_in to set on each beat past the cap, and those edits pass the check", () => {
    const therefore = (id: string) => withBeat(id, { extra: { connector_in: "therefore" } }).find((spec) => spec[0] === id)!;
    const beats = GOOD_BEATS.map((spec) => (["w2", "w3", "k2", "k3"].includes(spec[0]) ? therefore(spec[0]) : spec));

    const hint = hintFor(tour(beats), "Q-F1")!;
    const edits = [...hint.matchAll(/set connector_in to "(\w+)" on (\w+)/g)].map(([, connector, id]) => [id!, connector!] as const);
    const edited = beats.map((spec): BeatSpec => {
      const connector = edits.find(([id]) => id === spec[0])?.[1];
      return connector ? [spec[0], spec[1], spec[2], spec[3], { ...spec[4], connector_in: connector }] : spec;
    });

    expect(hint).toContain('"therefore" opens 4 of 7 linked beats, past the 40 % one connective may carry: w2, w3, k2, k3');
    expect(edits).toEqual([["k2", "but"], ["k3", "so"]]);
    expect(runL0(tour(edited), undefined, [flowCheck]).find((r) => r.check_id === "Q-F1")?.pass).toBe(true);
  });

  // Mutation: dropping the passing link rate or the connective tally leaves the repair guessing which half failed.
  it("Q-F1 says the link rate passes and variety fails, with each value, the connective tally, and to keep the link", () => {
    const therefore = (id: string) => withBeat(id, { extra: { connector_in: "therefore" } }).find((spec) => spec[0] === id)!;
    const beats = GOOD_BEATS.map((spec) => (["w2", "w3", "k2", "k3"].includes(spec[0]) ? therefore(spec[0]) : spec));

    const hint = hintFor(tour(beats), "Q-F1")!;

    expect(hint).toMatch(/^link rate passes: 100 % of in-chapter boundaries link \(needs 70 %\); connective variety fails at 57 % \(at most 40 %\)/);
    expect(hint).toContain("(connectives: therefore x4; 3 by a reference or a shared word)");
    expect(hint).toContain("vary the connective, never drop the link");
  });

  it("Q-F1 says the link rate fails and variety passes, naming the unlinked beats", () => {
    const swap: Record<string, string> = { w2: "Here is the desk server.", w3: "Parcels weigh little.", k2: "Vans park outside." };
    const beats = GOOD_BEATS.map(([id, chapter, fn, text, extra]): BeatSpec => [id, chapter, fn, swap[id] ?? text, extra]);

    const hint = hintFor(tour(beats), "Q-F1");

    expect(hint).toBe(
      'link rate fails: 57 % of in-chapter boundaries link (needs 70 %); unlinked: w2, w3, k2; open each on a connective, a "this" or "that" back-reference, or a word the beat before ends on; connective variety passes',
    );
  });

  it("Q-F3 quotes the anchor and lists the HOW beats that never name it", () => {
    const script = tour(GOOD_BEATS, { running_example: { scenario: "Parcel P-7 arrives late", anchor: "parcel p-7" } });

    expect(hintFor(script, "Q-F3")).toBe(
      'running_example.anchor "parcel p-7" must appear as written in a HOOK beat and in 50 % of HOW beats (spoken, assertion, a label, a chip or the code file); HOW beats without it: k1, k2, k3',
    );
  });

  it("Q-F16 names the identifier the voice says first and where", () => {
    const script = tour(withBeat("h2", { spoken: "That refusal works because the GitHub desk checks every scan against the ledger." }));

    expect(hintFor(script, "Q-F16")).toMatch(/^the first identifier the voice says is "GitHub" in h2, after \d+ % of the words \(needs 40 %\)/);
  });

  it("Q-V10 names each undeclared heteronym, its place and the declarations that would settle it", () => {
    const script = tour(withBeat("w2", { spoken: "The desk server will read each scan, so nothing prints early." }));

    expect(hintFor(script, "Q-V10")).toMatch(/; w2 "read" \(word 5; write \[read\]\(=\w+\) or \[read\]\(=\w+\)\)/);
  });

  it("Q-V13 names each over-long headline and the line budget", () => {
    const headline = "The parcel desk compares every incoming label against the shelf ledger before anything prints, then refuses the stale ones and tells the courier why at once";
    const script = tour(withBeat("w2", { extra: { visual: { assertion: headline, job: "artifact-filling" } } }));

    expect(hintFor(script, "Q-V13")).toBe(`headlines past the band: w2 "${headline}" (3 lines). The band shows 2 lines of about 55 characters; shorten each to fit`);
  });

  it("Q-E20 quotes the claims of each beat the gathered facts do not back", () => {
    const script = tour(withBeat("w2", { spoken: "So three open PRs wait at the desk, and PD-three hundred ten holds them.", extra: { fact_ids: ["pr/acme/desk#4/opened"] } }));
    const facts = [{ id: "pr/acme/desk#4/opened", change: "opened" }, { id: "task/PD-310/opened" }];
    const row = runL0(script, undefined, [claimsCheckWith(facts)])[0]!;

    expect(repairHint(row, script)).toMatch(/^claims the gathered facts do not back are among w2: "PD-310", "3 open PRs"\. Name only/);
  });

  // Mutation: ignoring the facts quotes the claim alone, with no fact for the repair to correct it by.
  it("Q-E20 names the nearest gathered fact for each unbacked claim when it has the facts", () => {
    const script = tour(withBeat("w2", { spoken: "So three open PRs wait at the desk today.", extra: { fact_ids: ["pr/acme/desk#4/opened"] } }));
    const facts = [{ id: "pr/acme/desk#4/opened", change: "opened" }];
    const row = runL0(script, undefined, [claimsCheckWith(facts)])[0]!;

    expect(repairHint(row, script, facts)).toMatch(/^claims the gathered facts do not back are among w2 "3 open PRs" \(the cited facts count 1 .*pr\/acme\/desk#4\/opened.*\)\. Name only/);
  });

  it("Q-F11 names the long outro and its word count against the cap", () => {
    const script = tour(withBeat("c2", { spoken: "Check the row, then print the label for the courier at the desk today." }));

    expect(hintFor(script, "Q-F11")).toMatch(/; the last beat c2 says 14 words \(at most 8\)$/);
  });
});

describe("Q-D17 hint for a claim-card, which takes no cue", () => {
  const words = (n: number): string => Array.from({ length: n }, (_, i) => `lane${i % 3 === 0 ? "s" : ""}`).join(" ");
  const hintOf = (patch: Parameters<typeof dailyWith>[1]): string => {
    const script = dailyWith("reflection-2", patch);
    return repairHint(l0Row(script, "Q-D17"), script) ?? "";
  };

  it("a 9.3 s claim-card's hint names its word cap and offers a trim", () => {
    const hint = hintOf({ plannedS: 12, spoken: words(26) });

    const cap = Number(/at most (\d+) words \(now 26\)/.exec(hint)?.[1]);
    expect(cap).toBeGreaterThan(0);
    expect(cap).toBeLessThan(26);
    expect(hint).toContain(`Trim it to ${cap} words`);
  });

  it("a split hint keeps the beat floor and asks heldS on one piece", () => {
    const hint = hintOf({ plannedS: 20, heldS: 4, spoken: words(50) });

    const pieces = Number(/split it into (\d+) claim-card beats/.exec(hint)?.[1]);
    expect(pieces).toBeGreaterThanOrEqual(2);
    expect(20 / pieces).toBeGreaterThanOrEqual(6);
    expect(hint).toContain("6 s or longer by plannedS");
    expect(hint).toContain("heldS on one piece only");
  });

  it("offers no split when its pieces would fall under the beat floor", () => {
    const hint = hintOf({ plannedS: 10, spoken: words(26) });

    expect(hint).toContain("Trim it to");
    expect(hint).not.toContain("split it into");
    expect(hint).not.toContain("heldS on one piece");
  });

  it("a reflection claim-card split asks each piece to cite its slow fact", () => {
    const hint = hintOf({ plannedS: 20, spoken: words(50) });

    expect(hint).toContain("cite the slow/ fact it answers in every piece");
  });
});
