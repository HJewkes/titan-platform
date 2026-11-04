import { describe, expect, it } from "vitest";
import { laneRollups } from "./lane-rollup.js";
import { mergedPr, task, widgetLanes, WINDOW } from "./lanes-fakes.test-helpers.js";

const IN_DAY = "2030-01-02T15:00:00Z";
const DAY_BEFORE = "2030-01-01T15:00:00Z";

function studioDay() {
  const prs = [
    mergedPr(1, "Studio one (WS-1)", "agent-chat/st-a", [], 50),
    mergedPr(2, "Studio two (WS-2)", "agent-chat/st-b", [], 40),
    mergedPr(3, "Studio three (WS-3)", "agent-chat/st-c", [], 30),
    mergedPr(4, "Studio four (WS-4)", "agent-chat/st-d", [], 900),
    mergedPr(5, "Desk one (WS-5)", "agent-chat/dk-a", ["apps/desk"], 5),
    mergedPr(6, "Shop lockfile (WS-6)", "agent-chat/sh-a", [], 1),
  ];
  const tasks = [
    task("WS-1", ["studio"], IN_DAY), task("WS-2", ["studio"], IN_DAY), task("WS-3", ["studio"], IN_DAY),
    task("WS-4", ["studio"], DAY_BEFORE), task("WS-5", [], IN_DAY), task("WS-6", ["kind:upkeep"], IN_DAY),
  ];
  return { prs, tasks };
}

describe("daily lane rollups", () => {
  it("picks at most two ships from one lane, the rest from the next lane", () => {
    const { prs, tasks } = studioDay();

    const { rollups } = laneRollups(prs, tasks, widgetLanes(), WINDOW);

    expect(rollups.filter((item) => item.id.startsWith("ship/")).map((item) => item.id)).toEqual(["ship/studio/WS-1", "ship/studio/WS-2", "ship/desk/WS-5"]);
  });

  it("ranks a thread whose task closed in the window above a bigger one closed the day before", () => {
    const { prs, tasks } = studioDay();

    const { coverage } = laneRollups(prs, tasks, widgetLanes(), WINDOW);
    const studio = coverage.lanes.find((lane) => lane.id === "studio");

    expect(studio?.named).toEqual(["studio/WS-1", "studio/WS-2", "studio/WS-3"]);
    expect(studio?.counted).toBe(1);
  });

  it("covers every merged PR exactly once, named or counted under one lane", () => {
    const { prs, tasks } = studioDay();

    const { coverage } = laneRollups(prs, tasks, widgetLanes(), WINDOW);

    expect(coverage.merged).toBe(6);
    expect(coverage.prs).toHaveLength(6);
    expect(new Set(coverage.prs.map((entry) => entry.pr)).size).toBe(6);
    expect(coverage.lanes.reduce((sum, lane) => sum + lane.merged, 0)).toBe(6);
  });

  it("writes lane, goal and day rollups with the totals a script can speak", () => {
    const { prs, tasks } = studioDay();

    const { rollups, prs: laned } = laneRollups(prs, tasks, widgetLanes(), WINDOW);
    const byId = new Map(rollups.map((item) => [item.id, item]));

    expect(byId.get("lane/studio/rollup")?.title).toBe("Studio: 4 merged, 0 side quests, 1 goal moved");
    expect(byId.get("lane/studio/rollup")?.summary).toBe("named: Task WS-1; Task WS-2; Task WS-3; and 1 smaller merge, 0 of them side quests");
    expect(byId.get("lane/shop/rollup")?.title).toBe("Shop: 1 merged, 1 side quest, 0 goals moved");
    expect(byId.get("goal/shop/orders")?.summary).toBe("nothing merged toward it");
    expect(byId.get("day/rollup")?.title).toBe("6 merged across 1 repo");
    expect(laned.find((pr) => pr.id.includes("#6/"))).toMatchObject({ lane: "shop", role: "side-quest" });
  });
});
