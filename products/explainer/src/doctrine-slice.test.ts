import { describe, expect, it } from "vitest";
import { Q_RULES, VOCABULARY, craftRule, registryWith } from "./doctrine-fixtures.test-helpers.js";
import { DOCTRINE_STAGES, type DoctrineRule } from "./doctrine-schema.js";
import { findPromptLeaks, sliceForStage, type StageRequest } from "./doctrine-slice.js";

const rule = (id: string, overrides: Partial<DoctrineRule>): DoctrineRule => craftRule({ id, source: { doc: "direction", ref: id.slice(4) }, ...overrides });

const universal = rule("dir-P2", { enforcement: ["planner", "base"], stages: ["plan", "script", "build"] });
const starred = rule("dir-P6", { scope: { layer: "U*" }, param: "chapters.count", enforcement: ["planner"], stages: ["plan"] });
const tour = rule("dir-T1", { scope: { layer: "T", types: ["repo-tour"] }, enforcement: ["planner"], stages: ["plan", "script"] });
const argument = rule("dir-T2", { scope: { layer: "T", types: ["repo-argument"] }, enforcement: ["planner"], stages: ["plan", "script"] });
const publicOnly = rule("dir-T3", { scope: { layer: "T", audiences: ["public-youtube"] }, enforcement: ["human"], stages: ["publish"] });
const codeWalk = rule("dir-C3", { scope: { layer: "B", beats: ["code-walk"] }, enforcement: ["packet", "planner"], stages: ["plan", "script", "build"] });
const hook = rule("dir-C4", { scope: { layer: "B", beats: ["hook"] }, enforcement: ["packet"], stages: ["build"] });
const plannedLint = rule("dir-C10", { enforcement: ["lint"], stages: ["qa"], check: { kind: "lint", ref: "lint.x", live: false } });
const pendingToken = rule("motion-G5", { enforcement: ["token", "base"], stages: ["build", "render"], tokens: [{ name: "MOTION.video.hold", live: false }] });

// Code-enforced, so no prompt list may hold them; each would land in one if the leak filter slipped.
const liveGate = rule("dir-C9", { enforcement: ["gate", "planner"], stages: ["plan", "qa"], check: { kind: "gate", ref: "gate.readingHold", live: true } });
const liveToken = rule("motion-G4", { enforcement: ["token", "base"], stages: ["build", "render"], tokens: [{ name: "MOTION.video.dim", live: true }] });
const liveBeat = rule("dir-C5", { scope: { layer: "B", beats: ["code-walk"] }, enforcement: ["token", "packet"], stages: ["build"], tokens: [{ name: "MOTION.beat.walk", live: true }] });
const staleQrule = rule("dir-P9", { enforcement: ["lint", "planner"], stages: ["plan", "script", "qa"], check: { kind: "qrule", ref: "X1", live: false } });

const CODE_ENFORCED = new Set([liveGate.id, liveToken.id, liveBeat.id, staleQrule.id]);

const REGISTRY = registryWith(universal, starred, tour, argument, publicOnly, codeWalk, hook, plannedLint, pendingToken, liveGate, liveToken, liveBeat, staleQrule);

const slice = (request: StageRequest) => sliceForStage(REGISTRY, Q_RULES, request);
const ids = (rules: DoctrineRule[]): string[] => rules.map((found) => found.id);

describe("sliceForStage", () => {
  it("gives the plan prompt the universal and matching type rules, with the U* params", () => {
    const { prompt, params } = slice({ stage: "plan", type: "repo-tour", beats: ["code-walk"] });

    expect(ids(prompt)).toEqual(["dir-P2", "dir-P6", "dir-T1"]);
    expect(params).toEqual(["chapters.count"]);
  });

  it("adds the requested beats' rules to the script prompt", () => {
    expect(ids(slice({ stage: "script", type: "repo-argument", beats: ["code-walk"] }).prompt)).toEqual(["dir-C3", "dir-P2", "dir-T2"]);
  });

  it("splits build into universal base rules and packet rules for the requested beats", () => {
    const built = slice({ stage: "build", type: "repo-tour", beats: ["code-walk"] });

    expect([ids(built.prompt), ids(built.base), ids(built.packet)]).toEqual([[], ["dir-P2", "motion-G5"], ["dir-C3"]]);
    expect(built.tokens).toEqual(["MOTION.beat.walk", "MOTION.video.dim", "MOTION.video.hold"]);
  });

  it("returns every check rule at qa, live or planned", () => {
    expect(ids(slice({ stage: "qa", type: "repo-tour" }).checks)).toEqual(["dir-C10", "dir-C9", "dir-P9"]);
  });

  it("returns only token names at render", () => {
    expect(slice({ stage: "render", type: "repo-tour" })).toEqual({
      prompt: [],
      base: [],
      packet: [],
      checks: [],
      tokens: ["MOTION.video.dim", "MOTION.video.hold"],
      params: [],
    });
  });

  it("loads no prose at gather or select", () => {
    const empty = { prompt: [], base: [], packet: [], checks: [], tokens: [], params: [] };

    expect([slice({ stage: "gather", type: "repo-tour" }), slice({ stage: "select", type: "repo-tour" })]).toEqual([empty, empty]);
  });

  it("matches a type rule on its audience at publish", () => {
    expect(ids(slice({ stage: "publish", type: "repo-tour", audience: "public-youtube" }).prompt)).toEqual(["dir-T3"]);
    expect(ids(slice({ stage: "publish", type: "repo-tour", audience: "owner-internal" }).prompt)).toEqual([]);
  });

  const requests = DOCTRINE_STAGES.flatMap((stage) =>
    [...VOCABULARY.types, undefined].map((type): StageRequest => ({ stage, type, audience: "public-youtube", beats: VOCABULARY.beats })),
  );

  it.each(requests)("puts no code-enforced rule in a prompt list at $stage for $type", (request) => {
    const { prompt, base, packet } = slice(request);

    expect(ids([...prompt, ...base, ...packet]).filter((id) => CODE_ENFORCED.has(id))).toEqual([]);
  });
});

describe("findPromptLeaks", () => {
  it("flags a live doctrine rule by id or by its exact text", () => {
    const gateText = rule("dir-C11", { ...liveGate, id: "dir-C11", text: "Hold each reading beat" });
    const registry = registryWith(liveGate, gateText);

    expect(findPromptLeaks("Obey dir-C9. Hold each reading beat.", registry, Q_RULES)).toEqual([
      { rule: "dir-C11", matched: "Hold each reading beat" },
      { rule: "dir-C9", matched: "dir-C9" },
    ]);
  });

  it("flags an implemented Q-rule by id, alias or rule text", () => {
    const leaksIn = (text: string) => findPromptLeaks(text, registryWith(), Q_RULES);

    expect([leaksIn("See Q-V1."), leaksIn("Mind X1"), leaksIn("No spoken process narration, please")]).toEqual([
      [{ rule: "Q-V1", matched: "Q-V1" }],
      [{ rule: "Q-V1", matched: "X1" }],
      [{ rule: "Q-V1", matched: "No spoken process narration" }],
    ]);
  });

  it("ignores a pending Q-rule, a token name and an id that only prefixes another", () => {
    const text = "One why per beat. Use MOTION.video.dim. See Q-V10 and dir-C9.2.";

    expect(findPromptLeaks(text, registryWith(liveToken, liveGate), Q_RULES)).toEqual([]);
  });

  it("leaves a rule whose check is not live yet to the prompt", () => {
    expect(findPromptLeaks("Obey dir-C10. Show it as you say it", registryWith(plannedLint), Q_RULES)).toEqual([]);
  });
});
