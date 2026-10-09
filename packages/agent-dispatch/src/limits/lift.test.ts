import { describe, expect, it } from "vitest";
import { grantFromAnswer, liftQuestion, parseLimits, resolveLimits, type Grant, type ResolvedLimits } from "./index.js";
import today from "./fixtures/limits-today.json" with { type: "json" };

const NOW = new Date("2026-10-12T15:00:00Z");
const RESETS_AT = new Date("2026-10-12T17:40:00Z");
const parsed = parseLimits(today);

function agents(extra: { grants?: Grant[]; answeredQuestions?: Set<string>; now?: Date } = {}): ResolvedLimits {
  const result = resolveLimits(parsed, { pool: "agents", now: NOW, fiveHourResetsAt: RESETS_AT, ...extra });
  if (!result.open) throw new Error(result.reason);
  return result.limits;
}

describe("liftQuestion", () => {
  it("asks once when a liftable pool reaches its ceiling", () => {
    const question = liftQuestion({ limits: agents(), reading: { fiveHour: 95, resetsAt: RESETS_AT }, asked: new Set() });

    expect(question).toMatchObject({ pool: "agents", key: "agents:2026-10-12T17:40:00.000Z" });
    expect(question?.text).toBe("agents at 95% of five_hour, resets 2026-10-12T17:40:00.000Z: go to 100 until then?");
  });

  it("does not ask again for a window already asked", () => {
    const asked = new Set(["agents:2026-10-12T17:40:00.000Z"]);
    expect(liftQuestion({ limits: agents(), reading: { fiveHour: 97, resetsAt: RESETS_AT }, asked })).toBeNull();
  });

  it("does not ask below the ceiling or for a pool with no lift", () => {
    const owner = resolveLimits(parsed, { pool: "owner", now: NOW });
    if (!owner.open) throw new Error(owner.reason);

    expect(liftQuestion({ limits: agents(), reading: { fiveHour: 94, resetsAt: RESETS_AT }, asked: new Set() })).toBeNull();
    expect(liftQuestion({ limits: owner.limits, reading: { fiveHour: 100, resetsAt: RESETS_AT }, asked: new Set() })).toBeNull();
  });
});

describe("grants", () => {
  const question = { pool: "agents", key: "agents:2026-10-12T17:40:00.000Z", resetsAt: RESETS_AT, liftTo: 100, text: "" };
  const grant = grantFromAnswer(question, { questionId: "q-1", answer: "yes" });

  it("turn a yes into a grant that lasts until the window resets", () => {
    expect(grant).toEqual({ pool: "agents", ceiling_five_hour: 100, until: "2026-10-12T17:40:00.000Z", question: "q-1" });
    expect(grantFromAnswer(question, { questionId: "q-1", answer: "no" })).toBeNull();
  });

  it("open the gate above the ceiling once the owner answered", () => {
    const limits = agents({ grants: [grant!], answeredQuestions: new Set(["q-1"]) });

    expect(limits.ceiling_five_hour).toBe(100);
    expect(limits.sources.ceiling_five_hour).toBe("grant");
  });

  it("close again at until", () => {
    const later = new Date("2026-10-12T17:41:00Z");
    expect(agents({ grants: [grant!], answeredQuestions: new Set(["q-1"]), now: later }).ceiling_five_hour).toBe(95);
  });

  it("are ignored without an owner answer in the log", () => {
    expect(agents({ grants: [grant!] }).ceiling_five_hour).toBe(95);
  });

  it("are clamped to the pool's lift", () => {
    const greedy: Grant = { ...grant!, ceiling_five_hour: 140 };
    expect(agents({ grants: [greedy], answeredQuestions: new Set(["q-1"]) }).ceiling_five_hour).toBe(100);
  });

  it("are ignored when they outlast the five-hour window", () => {
    const long: Grant = { ...grant!, until: "2026-10-13T00:00:00.000Z" };
    expect(agents({ grants: [long], answeredQuestions: new Set(["q-1"]) }).ceiling_five_hour).toBe(95);
  });
});
