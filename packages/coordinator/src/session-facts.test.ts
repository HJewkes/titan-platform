import { describe, expect, it } from "vitest";
import { projectSeatGeneration, sessionFactsSchema } from "./session-facts.js";
import { emptySeatState } from "./seat-state.js";

const scopes = { TP: "alpha", AW: "beta", CC: "gamma" };
const state = { ...emptySeatState(), generation: 4 };

describe("projectSeatGeneration", () => {
  it("yields one record per touched initiative holding only that initiative's work", () => {
    const activity = {
      mergedPrs: [
        { repo: "o/a", number: 1, agent: "sx-tp-10-fix" },
        { repo: "o/b", number: 2, agent: "sx-aw-20-feat" },
        { repo: "o/a", number: 3, agent: "sx-tp-11-fix" },
      ],
      closedTasks: ["TP-10", "CC-5"],
      filedTasks: ["AW-21"],
    };

    const records = projectSeatGeneration(state, activity, scopes);

    expect(records.map((r) => r.scope)).toEqual(["alpha", "beta", "gamma"]);
    expect(records[0]).toEqual({
      scope: "alpha",
      generation: 4,
      mergedPrs: [
        { repo: "o/a", number: 1, taskId: "TP-10" },
        { repo: "o/a", number: 3, taskId: "TP-11" },
      ],
      closedTasks: ["TP-10"],
      filedTasks: [],
    });
    expect(records[1]).toMatchObject({ mergedPrs: [{ number: 2 }], closedTasks: [], filedTasks: ["AW-21"] });
    expect(records[2]).toMatchObject({ mergedPrs: [], closedTasks: ["CC-5"], filedTasks: [] });
    records.forEach((r) => expect(sessionFactsSchema.parse(r)).toEqual(r));
  });

  it("yields nothing for an initiative the generation did not touch", () => {
    const records = projectSeatGeneration(state, { mergedPrs: [], closedTasks: ["TP-1"], filedTasks: [] }, scopes);

    expect(records.map((r) => r.scope)).toEqual(["alpha"]);
  });

  it("drops work whose prefix or agent name maps to no initiative", () => {
    const activity = {
      mergedPrs: [{ repo: "o/a", number: 9, agent: "unrelated-agent" }],
      closedTasks: ["ZZ-1"],
      filedTasks: [],
    };

    expect(projectSeatGeneration(state, activity, scopes)).toEqual([]);
  });
});
