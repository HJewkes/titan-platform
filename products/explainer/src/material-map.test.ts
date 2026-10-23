import { describe, expect, it } from "vitest";
import { loadDoctrine } from "./doctrine-load.js";
import { parseFacts, type MaterialFact } from "./material-facts.js";
import { buildMaterialMap, type MaterialMap } from "./material-map.js";
import { SIGNAL_GAPS, SIGNAL_RULES } from "./material-signals.js";
import { loadProfiles, profileFor } from "./profile-load.js";

const set = loadProfiles();
const vocabulary = loadDoctrine().vocabulary.signals;

const factsOf = (texts: readonly string[]): MaterialFact[] => texts.map((text, i) => ({ id: `F${i + 1}`, text }));

function mapOf(facts: readonly MaterialFact[], type = "repo-tour"): MaterialMap {
  return buildMaterialMap({ factsSha: "0".repeat(64), format: "facts-md", facts, profile: profileFor(set, type), structures: set.structures, vocabulary });
}

const holding = (map: MaterialMap) => map.signals.filter((row) => row.holds === true).map((row) => row.id).sort();
const fitting = (map: MaterialMap) => map.fits.filter((row) => row.fit === "fits").map((row) => row.structure).sort();
const fitOf = (map: MaterialMap, id: string) => map.fits.find((row) => row.structure === id)!;

const CASES: { name: string; facts: string[]; signals: string[]; fits: string[] }[] = [
  { name: "a neutral fact", facts: ["The service keeps records in a table."], signals: [], fits: [] },
  { name: "a pending decision", facts: ["The owner should adopt the new cache."], signals: ["decision-pending"], fits: ["scqa"] },
  { name: "an anomaly", facts: ["The counter silently drops every tenth event."], signals: ["anomaly"], fits: ["mystery"] },
  { name: "two changes", facts: ["Startup went from 40 s to 10 s.", "The new parser replaced the regex scanner."], signals: ["before-after"], fits: ["before-after"] },
  { name: "an attempt that failed", facts: ["We tried a global lock.", "The lock failed under load."], signals: ["attempts-failed"], fits: ["attempt-journey"] },
  { name: "four review rounds", facts: ["Review took four rounds."], signals: ["many-review-rounds"], fits: ["review-saga"] },
  { name: "three parallel lints", facts: ["One lint flags long labels.", "One lint flags dark text.", "One lint flags clipped arrows."], signals: ["parallel-findings"], fits: ["countdown"] },
  { name: "a measured result", facts: ["We measured 40 ms against 55 ms."], signals: ["experiment"], fits: ["lab-report"] },
  { name: "a cascade", facts: ["The outage triggered a retry storm.", "The storm led to a full queue."], signals: ["cascade"], fits: ["timeline"] },
  { name: "work moving on the board", facts: ["TP-1 moved to review.", "TP-2 closed.", "TP-3 merged."], signals: ["board-moved"], fits: ["board-walk"] },
  { name: "a status report", facts: ["TP-1 is on track.", "TP-2 is on track.", "TP-3 is on track.", "TP-4 is on track.", "TP-5 is on track."], signals: ["status-report"], fits: ["bluf"] },
  { name: "a repo laid out", facts: ["Gizmo is a small build tool.", "Its entry point is the bin script.", "The code sits in three packages."], signals: ["repo-overview"], fits: ["scqa-c4"] },
  { name: "one task end to end", facts: ["First the client sends a request.", "Then the gateway checks the token.", "Finally the worker writes a row."], signals: ["task-journey"], fits: ["design-journey"] },
  { name: "one central problem", facts: ["Builds are slow on every laptop."], signals: ["central-problem"], fits: ["abt", "three-act"] },
];

describe("material map signals and fits", () => {
  it.each(CASES)("$name: fires exactly its signals and fits exactly its structures", ({ facts, signals, fits }) => {
    const map = mapOf(factsOf(facts));

    expect(holding(map)).toEqual([...signals].sort());
    expect(fitting(map)).toEqual([...fits].sort());
  });

  it("names the facts behind a signal and the reason for each fit", () => {
    const map = mapOf(factsOf(["The weather is mild.", "The counter silently drops events."]));

    expect(map.signals.find((row) => row.id === "anomaly")).toMatchObject({ holds: true, facts: ["F2"] });
    expect(fitOf(map, "mystery").reasons).toEqual(["any of [anomaly]: anomaly holds"]);
  });

  it("four pains are a list of complaints, not one central problem", () => {
    const map = mapOf(factsOf(["Builds are slow.", "Deploys are manual.", "Tests are tedious.", "Reviews are blocked."]));

    expect(holding(map)).not.toContain("central-problem");
  });

  it("two review rounds are not a saga", () => {
    expect(holding(mapOf(factsOf(["Review took 2 rounds."])))).not.toContain("many-review-rounds");
  });

  it("an attempt with no failure is not a failed attempt", () => {
    expect(holding(mapOf(factsOf(["We tried a global lock."])))).not.toContain("attempts-failed");
  });

  it("five status items among many other facts are not a status report", () => {
    const items = [1, 2, 3, 4, 5].map((n) => `TP-${n} is on track.`);
    const others = [1, 2, 3, 4, 5, 6].map((n) => `Table ${n} keeps records.`);

    expect(holding(mapOf(factsOf([...items, ...others])))).not.toContain("status-report");
  });

  it("a method cue with no number is not an experiment", () => {
    expect(holding(mapOf(factsOf(["We measured it by hand once."])))).not.toContain("experiment");
  });
});

describe("gap signals and runtime bounds", () => {
  it("lists elegant-idea as a gap and leaves a structure that turns on it undecided", () => {
    const map = mapOf(factsOf(["The service keeps records in a table."]));

    expect(map.gaps).toEqual(["elegant-idea"]);
    expect(map.signals.find((row) => row.id === "elegant-idea")?.holds).toBeNull();
    expect(fitOf(map, "kishotenketsu")).toMatchObject({ fit: "undecided", reasons: expect.arrayContaining([expect.stringContaining("elegant-idea is a gap")]) });
  });

  it("decides a gap structure when the known signals settle it either way", () => {
    expect(fitOf(mapOf(factsOf(["Builds are slow on every laptop."])), "kishotenketsu").fit).toBe("no");
  });

  it("a short profile puts three-act outside its runtime bound", () => {
    const map = mapOf(factsOf(["Builds are slow on every laptop."]), "pr-overview");

    expect(fitOf(map, "three-act")).toMatchObject({ fit: "no", reasons: expect.arrayContaining(["runtime 150 s outside [300, ∞] s"]) });
    expect(fitOf(map, "abt").fit).toBe("fits");
  });
});

describe("candidates and metrics", () => {
  it("a structure the profile does not allow fits but is no candidate", () => {
    const map = mapOf(factsOf(["The owner should adopt the new cache.", "The counter silently drops events."]), "pr-overview");

    expect(fitting(map)).toEqual(["mystery", "scqa"]);
    expect(fitOf(map, "mystery").allowed).toBe(false);
    expect(map.candidates).toEqual(["scqa"]);
  });

  it("counts P1 facts and the largest move a change states", () => {
    const facts: MaterialFact[] = [{ id: "a", text: "Latency went from 40 to 10 ms.", priority: "P1" }, { id: "b", text: "Size went from 10 to 12.", priority: "P2" }];

    expect(mapOf(facts).metrics).toEqual({ p1Count: 1, maxDeltaVsBaseline: 0.75 });
  });

  it("is the same map for the same facts, profile and registry", () => {
    const facts = factsOf(["The owner should adopt the new cache.", "Startup went from 40 s to 10 s."]);

    expect(JSON.stringify(mapOf(facts))).toBe(JSON.stringify(mapOf(facts)));
  });
});

describe("signal vocabulary", () => {
  it("has a rule or a listed gap for every vocabulary signal, and nothing else", () => {
    expect([...Object.keys(SIGNAL_RULES), ...Object.keys(SIGNAL_GAPS)].sort()).toEqual([...vocabulary].sort());
  });
});

describe("facts packs", () => {
  it("reads the facts table of a markdown pack and skips other tables", () => {
    const text = "# Facts\n\n| Key | Meaning |\n|---|---|\n| S | source |\n\n| Id | Claim | Beat(s) |\n|---|---|---|\n| F01 | One claim. | b01 |\n| F02 | Two claims. | b02 |\n";

    expect(parseFacts(text)).toEqual({ format: "facts-md", facts: [{ id: "F01", text: "One claim." }, { id: "F02", text: "Two claims." }] });
  });

  it("reads gather facts as JSON lines, keeping kind and priority", () => {
    const text = `${JSON.stringify({ id: "f1", text: "A claim.", kind: "gotcha", tier: "P1", source: "row" })}\n`;

    expect(parseFacts(text)).toEqual({ format: "facts-jsonl", facts: [{ id: "f1", text: "A claim.", kind: "gotcha", priority: "P1" }] });
  });

  it("refuses a pack with no facts or a repeated id", () => {
    expect(() => parseFacts("# Notes\n\nNo table here.\n")).toThrow(/no facts/);
    expect(() => parseFacts("| Id | Claim |\n|---|---|\n| F1 | a |\n| F1 | b |\n")).toThrow(/F1 twice/);
  });
});
