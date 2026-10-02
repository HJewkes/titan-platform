import { describe, expect, it } from "vitest";
import { scorecardKeyHash, variantHash } from "./hash.js";
import { parseSpec, parseTrialRecord } from "./spec/index.js";
import type { Scorecard, UnitSpec, VariantSpec } from "./spec/index.js";
import { readFixture } from "./test-fixtures.js";
import { scorecardKeysFor, startTrial } from "./trial.js";
import type { ChampionOf } from "./trial.js";

const unit = parseSpec(readFixture("unit.json")) as UnitSpec;
const singlePass = parseSpec(readFixture("variants/single-pass.json")) as VariantSpec;
const scorecard = parseSpec(readFixture("scorecard.json")) as Scorecard;
const { suite, judges, env } = scorecard.keys;
const CASE = scorecard.perCase[0]!.case;
const STARTED_AT = "2026-10-01T00:00:00Z";
/** The fixture scorecard's key hash as computed before trials recorded champions. */
const FIXTURE_KEY_HASH = "5baae949f13c1190ef1d60136817f95197e6c3d0e29c27c3f7126bafc37c210f";

function withModel(variant: VariantSpec, model: string): VariantSpec {
  const step = variant.steps.summarize as Extract<VariantSpec["steps"][string], { kind: "llm" }>;
  return { ...variant, id: model, steps: { summarize: { ...step, model } } };
}

const championA = withModel(singlePass, "claude-sonnet-5-5");
const championB = withModel(singlePass, "claude-opus-5-5");
const childRef = { id: "child-unit", version: "1.0.0" };
const delegating: VariantSpec = { ...singlePass, id: "delegating", steps: { delegate: { kind: "unit", unit: childRef, variant: "champion" } } };

/** A champion slot the test can move between trials. */
function championSlot(initial: VariantSpec) {
  let holder = initial;
  const championOf: ChampionOf = () => holder;
  return { championOf, crown: (next: VariantSpec) => { holder = next; } };
}

async function trialOf(variant: VariantSpec | "champion", championOf: ChampionOf) {
  return startTrial({ unit, variant, caseHash: CASE, startedAt: STARTED_AT, championOf });
}

const keyOf = (trial: Awaited<ReturnType<typeof trialOf>>) => scorecardKeyHash(scorecardKeysFor(trial, { suite, judges, env }));

describe("a trial run against the champion", () => {
  it("records a different resolved hash and key when the champion changes between two trials", async () => {
    const slot = championSlot(championA);

    const first = await trialOf("champion", slot.championOf);
    slot.crown(championB);
    const second = await trialOf("champion", slot.championOf);

    expect([first.variant, second.variant]).toEqual([variantHash(championA), variantHash(championB)]);
    expect(keyOf(first)).not.toBe(keyOf(second));
  });

  it("records a child champion step's resolved hash and keys on it, though the parent's hash stays put", async () => {
    const slot = championSlot(championA);

    const first = await trialOf(delegating, slot.championOf);
    slot.crown(championB);
    const second = await trialOf(delegating, slot.championOf);

    expect(first.variant).toBe(second.variant);
    expect(first.champions).toEqual({ delegate: variantHash(championA) });
    expect(second.champions).toEqual({ delegate: variantHash(championB) });
    expect(keyOf(first)).not.toBe(keyOf(second));
  });

  it("records a champion's own champion step under its step path", async () => {
    const outer: VariantSpec = { ...delegating, unit: { id: "outer-unit", version: "1.0.0" } };
    const championOf: ChampionOf = (ref) => (ref.id === "child-unit" ? { ...delegating, unit: childRef, steps: { inner: { kind: "unit", unit: { id: "leaf", version: "1.0.0" }, variant: "champion" } } } : championA);

    const trial = await trialOf(outer, championOf);

    expect(Object.keys(trial.champions ?? {})).toEqual(["delegate", "delegate/inner"]);
  });

  it("refuses a champion that delegates back to a unit already running above it", async () => {
    const loop: VariantSpec = { ...delegating, unit: childRef, steps: { again: { kind: "unit", unit: childRef, variant: "champion" } } };

    await expect(trialOf(delegating, () => loop)).rejects.toThrow(/champion cycle at step delegate\/again/);
  });
});

describe("a trial run against a named variant", () => {
  it("keeps today's scorecard key and records no champions", async () => {
    const trial = await trialOf(singlePass, () => {
      throw new Error("a named variant never consults the champion slot");
    });

    expect(trial.champions).toBeUndefined();
    expect(keyOf(trial)).toBe(FIXTURE_KEY_HASH);
    expect(scorecardKeyHash(scorecard.keys)).toBe(FIXTURE_KEY_HASH);
  });
});

describe("records written before champions were recorded", () => {
  it("loads a trial record with no champions field", () => {
    const old = { schema: "titan.trial/v1", unit: scorecard.keys.unit, variant: scorecard.keys.variant, case: CASE, startedAt: STARTED_AT };

    expect(parseTrialRecord(old)).toEqual(old);
    expect(parseTrialRecord(old, "strict")).toEqual(old);
  });

  it("loads a scorecard with no champions in its key, which keeps its old key hash", () => {
    const old = readFixture<Scorecard>("scorecard.json");

    expect(old.keys).not.toHaveProperty("champions");
    expect(scorecardKeyHash((parseSpec(old, "loose") as Scorecard).keys)).toBe(FIXTURE_KEY_HASH);
  });
});
