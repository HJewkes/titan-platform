import { describe, expect, it } from "vitest";
import { agentChatOldPaths, findSunsetManifest } from "./old-paths.js";
import { readSlices } from "./report.js";

const planOf = (...slices: object[]): string => `\`\`\`burndown-slices\n${JSON.stringify(slices)}\n\`\`\``;
const agentChat = (owns: string[], extra: object = {}) => ({ n: "s1", title: "t", repo: "agent-chat", owns, points: 1, doneWhen: "d", ...extra });

describe("the agent-chat old-path warning", () => {
  it("warns once, and refuses nothing, for a slice growing agent-chat src with no carve-out", () => {
    const read = readSlices(planOf(agentChat(["src/agents/isolation/x.ts"])));

    expect(read.problems).toBeUndefined();
    expect(read.warnings).toEqual([
      "slice s1: adds to agent-chat src (old path, fold task TP-646); name the package home or set carveOut",
    ]);
  });

  it("names each fold task once across a slice's owns", () => {
    const read = readSlices(planOf(agentChat(["src/agents/foo.ts", "src/agents/supervisor.ts", "src/agents/bar.ts"])));

    expect(read.warnings).toEqual(["slice s1: adds to agent-chat src (old path, fold task TP-647); name the package home or set carveOut"]);
  });

  it("stays quiet for a carve-out, a surviving area, or a slice in another repo", () => {
    const plans = [
      planOf(agentChat(["src/agents/foo.ts"], { carveOut: "superseded-at:TP-647" })),
      planOf(agentChat(["src/broker/x.ts", "src/agents/teleport.ts"])),
      planOf(agentChat(["src/agents/foo.ts"], { repo: "titan-platform" })),
    ];

    expect(plans.map((plan) => readSlices(plan).warnings)).toEqual([[], [], []]);
  });

  it("reads its old paths from the checked-in sunset manifest", () => {
    expect(findSunsetManifest()).toMatch(/products\/factory\/sunset\/manifest\.json$/);
    expect(agentChatOldPaths().find((rule) => rule.path === "src/agents/isolation")).toEqual({ path: "src/agents/isolation", fate: "delete", task: "TP-646" });
  });
});
