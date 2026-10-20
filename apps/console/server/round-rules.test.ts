import { describe, expect, it } from "vitest";
import type { Manifest } from "./round-schema.js";
import { roundRuleProblems, roundRuleRefusal } from "./round-rules.js";
import { parseManifest } from "./rounds.js";

// Synthetic rounds only: an example/cards Ship round with one framed section and a decision section.
const HEAD = "0123456789abcdef0123456789abcdef01234567";
const PR = "example/cards#2";

type Json = Record<string, unknown>;

function shipQuestion(overrides: Json = {}): Json {
  return {
    id: "ship",
    kind: "pick-one",
    prompt: `Ship ${PR}?`,
    options: ["Ship", "Don't ship"],
    required: true,
    page: PR,
    signsOff: "card",
    merge: { repo: "example/cards", pr: 2, headSha: HEAD, ship: ["Ship"] },
    ...overrides,
  };
}

const toneQuestion = (): Json => ({ id: "tone", kind: "pick-one", prompt: "Which tone reads better?", options: ["Light", "Dark"], page: PR, frames: ["card-light", "card-dark"], signsOff: "card" });

const section = (id: string, questionIds: string[], variantKeys: string[] = []): Json => ({
  id,
  title: id,
  deciding: `What ${id} decides.`,
  changed: `What ${id} changed.`,
  context: `Context for ${id}.`,
  ...(variantKeys.length > 0 ? { kind: "STATES" } : {}),
  variantKeys,
  questionIds,
});

const variant = (key: string, extra: Json = {}): Json => ({ key, storyId: `cards--${key}`, label: key, change: "changed", ...extra });

function baseRound(): Json {
  return {
    schema: "titan-review/round@2",
    unit: "cards",
    round: 1,
    storybookUrl: "http://localhost:6006",
    widths: [1280],
    variants: [variant("card-light"), variant("card-dark")],
    sections: [section("cards", ["tone"], ["card-light", "card-dark"]), section("decision", ["ship"])],
    questions: [toneQuestion(), shipQuestion()],
  };
}

function manifestOf(round: Json): Manifest {
  const parsed = parseManifest(Buffer.from(JSON.stringify(round)));
  if (!parsed.ok) throw new Error(`the synthetic round does not parse: ${parsed.reason}`);
  return parsed.manifest;
}

function edited(edit: (round: Json) => void): Manifest {
  const round = baseRound();
  edit(round);
  return manifestOf(round);
}

const rulesOf = (manifest: Manifest) => roundRuleProblems(manifest).map((problem) => problem.rule);

describe("round builder rules", () => {
  it("pass a round with each decision under its frames and Ship last", () => {
    expect(roundRuleProblems(manifestOf(baseRound()))).toEqual([]);
  });

  it("refuse a Ship asked before side questions in its section, as td988's shape was (ship-not-last)", () => {
    const manifest = edited((round) => {
      round.sections = [section("cards", [], ["card-light", "card-dark"]), section("decision", ["ship", "plane", "notes"])];
      round.questions = [
        shipQuestion(),
        { id: "plane", kind: "pick-one", prompt: "Which plane colour?", options: ["Base", "Raised"], signsOff: "card", decision: "decide", implemented: "Base" },
        { id: "notes", kind: "text", prompt: "Anything else?" },
      ];
    });

    expect(roundRuleProblems(manifest)).toEqual([
      { rule: "ship-not-last", message: "question ship: Ship is asked before plane, notes in section decision; ask Ship last" },
    ]);
  });

  it("report a Ship that is both outside its PR's last section and before a side question once (ship-not-last)", () => {
    const manifest = edited((round) => {
      round.sections = [section("decision", ["ship", "aside"]), section("cards", ["tone"], ["card-light", "card-dark"])];
      round.questions = [shipQuestion(), { id: "aside", kind: "text", prompt: "Anything else?" }, { id: "tone", kind: "text", prompt: "Anything on the tone?", page: PR }];
    });

    expect(roundRuleProblems(manifest)).toEqual([
      { rule: "ship-not-last", message: `question ship: Ship sits in section decision, but ${PR}'s last section is cards` },
    ]);
  });

  it.each([
    ["a pick that decides what its section shows without naming frames", "unanchored-question", (round: Json) => {
      round.questions = [{ id: "tone", kind: "pick-one", prompt: "Which tone?", options: ["Light", "Dark"], page: PR, signsOff: "card" }, shipQuestion()];
    }],
    ["a question naming a frame from another section", "frame-outside-section", (round: Json) => {
      round.variants = [variant("card-light"), variant("card-dark"), variant("card-wide")];
      round.sections = [section("cards", ["tone"], ["card-light", "card-dark"]), section("decision", ["ship"], ["card-wide"])];
      round.questions = [{ id: "tone", kind: "pick-one", prompt: "Which tone?", options: ["Light", "Dark"], page: PR, frames: ["card-light", "card-wide"], signsOff: "card" }, shipQuestion()];
    }],
    ["a PR's sections split by another section", "split-pr-group", (round: Json) => {
      round.variants = [variant("card-light"), variant("card-dark"), variant("other")];
      round.sections = [section("cards", ["tone"], ["card-light", "card-dark"]), section("aside", ["aside"], ["other"]), section("decision", ["ship"])];
      round.questions = [
        { id: "tone", kind: "pick-one", prompt: "Which tone?", options: ["Light", "Dark"], page: PR, frames: ["card-light", "card-dark"], signsOff: "card" },
        { id: "aside", kind: "pick-one", prompt: "Which other?", options: ["A", "B"], frames: ["other"], signsOff: "card" },
        shipQuestion(),
      ];
    }],
    ["a Ship prompt naming another PR", "ship-head-mismatch", (round: Json) => {
      round.questions = [toneQuestion(), shipQuestion({ prompt: `Ship ${PR} with example/cards#7?` })];
    }],
    ["a decide pick with no implemented option", "missing-implemented-option", (round: Json) => {
      round.questions = [{ id: "tone", kind: "pick-one", prompt: "Which tone?", options: ["Light", "Dark"], page: PR, frames: ["card-light", "card-dark"], signsOff: "card", decision: "decide" }, shipQuestion()];
    }],
    ["a new frame with a base image", "base-on-new-frame", (round: Json) => {
      round.variants = [variant("card-light", { change: "new", baseImage: "frames/card-light-base.png" }), variant("card-dark")];
    }],
  ])("refuse %s (%s)", (_name, rule, edit) => {
    expect(rulesOf(edited(edit))).toEqual([rule]);
  });

  it("name every rule in the refusal", () => {
    const manifest = edited((round) => {
      round.questions = [{ id: "tone", kind: "pick-one", prompt: "Which tone?", options: ["Light", "Dark"], page: PR, signsOff: "card" }, shipQuestion({ prompt: `Ship ${PR} with example/cards#7?` })];
    });

    expect(roundRuleRefusal(manifest)).toMatch(/^round\.json breaks the builder rules: unanchored-question: question tone: .*; ship-head-mismatch: question ship: /);
  });
});
