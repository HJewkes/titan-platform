import { describe, expect, it } from "vitest";
import { loadLanes } from "../../lanes-schema.js";
import { attributeLanes, namedCount, threadsOf } from "./lanes.js";
import { mergedPr, task, widgetLanes, WINDOW } from "./lanes-fakes.test-helpers.js";

const PRS = [
  mergedPr(1, "Studio timeline (WS-10)", "agent-chat/st-ws10", ["apps/desk"]),
  mergedPr(2, "Studio export (WS-11)", "feat/studio-export", ["products/studio"]),
  mergedPr(3, "Retry the desk build", "fix-widgets-0a1b2c3", ["apps/desk"]),
  mergedPr(4, "Bump the lockfile (WS-12)", "agent-chat/sh-ws12", ["packages/core"]),
  mergedPr(5, "Order queue (WS-13)", "agent-chat/sh-ws13a", ["packages/orders"]),
  mergedPr(6, "Order queue retries (WS-13)", "agent-chat/sh-ws13b", ["packages/orders"]),
];
const TASKS = [task("WS-10", ["studio"]), task("WS-11", ["studio"]), task("WS-12", ["orders", "kind:upkeep"]), task("WS-13", ["orders"])];

describe("daily lanes", () => {
  it("places a PR by its branch seat before its paths, then by paths, then the fallback", () => {
    const laned = attributeLanes(PRS, TASKS, widgetLanes());

    expect(laned.map((pr) => [pr.item.id.split("#")[1], pr.lane])).toEqual([
      ["1/merged", "studio"], ["2/merged", "studio"], ["3/merged", "desk"],
      ["4/merged", "shop"], ["5/merged", "shop"], ["6/merged", "shop"],
    ]);
  });

  it("takes a lane from the PR's repo when the branch names no seat", () => {
    const lanes = widgetLanes();
    lanes.lanes[1]!.repos = ["acme/widgets"];

    const [laned] = attributeLanes([mergedPr(7, "Tidy docs", "docs/tidy", ["docs/guide"])], [], lanes);

    expect(laned?.lane).toBe("desk");
  });

  it("makes an upkeep-tagged task a side quest even when its tags also meet a goal", () => {
    const laned = attributeLanes(PRS, TASKS, widgetLanes());

    expect(laned.map((pr) => pr.role)).toEqual(["goal", "goal", "other", "side-quest", "goal", "goal"]);
    expect(laned[4]?.goal).toBe("orders");
  });

  it("threads the PRs of one task together and leaves a task-less PR on its own", () => {
    const threads = threadsOf(attributeLanes(PRS, TASKS, widgetLanes()), WINDOW);

    expect(threads.map((thread) => [thread.id, thread.prs.length])).toEqual([
      ["studio/WS-10", 1], ["studio/WS-11", 1], [`desk/pr/acme/widgets#3/merged`, 1], ["shop/WS-12", 1], ["shop/WS-13", 2],
    ]);
  });

  it("names one thread in a small lane and at most four in a lane holding the whole day", () => {
    const { named } = widgetLanes();

    expect(namedCount(1, 40, named)).toBe(1);
    expect(namedCount(40, 40, named)).toBe(4);
    expect(namedCount(20, 40, named)).toBe(3);
  });

  it("loads the doctrine default lanes file", () => {
    const lanes = loadLanes();

    expect(lanes.lanes.map((lane) => lane.id)).toContain(lanes.fallback);
  });
});
