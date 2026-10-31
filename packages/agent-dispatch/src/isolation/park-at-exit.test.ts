import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NO_VERDICT,
  isVerdictText,
  parkImplementerAtExit,
  parkReviewerAtReport,
  type ImplementerParkPort,
  type ReviewerParkPort,
} from "./index.js";
import { agent, allocated } from "./retire-test-support.js";

/** CC-1039 and CC-976: a finished tree is parked at exit, the branch kept and the agent not retired. */

const trees: string[] = [];
afterEach(() => {
  for (const dir of trees.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});
const realTree = (): string => {
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "park-exit-"))
  );
  trees.push(dir);
  return dir;
};

function implementerPort(
  name: string,
  over: Partial<ImplementerParkPort> = {}
) {
  const tree = realTree();
  const park = vi.fn(async () => ({ ok: true }));
  const port: ImplementerParkPort = {
    current: () => agent(name),
    events: () => [allocated(name, `agent-chat/${name}`, tree)],
    enabled: () => true,
    treeHold: () => undefined,
    park,
    ...over,
  };
  return { port, park, tree };
}

function reviewerPort(
  over: Partial<ReviewerParkPort> = {},
  held: { report?: string; final?: string } = {}
) {
  const name = "rv-1";
  const park = vi.fn(async () => ({ ok: true }));
  const port: ReviewerParkPort = {
    current: () => agent(name, { profile: "reviewer" }),
    events: () => [allocated(name, `agent-chat/${name}`, realTree())],
    lastReport: () => held.report,
    finalText: () => held.final,
    park,
    ...over,
  };
  return { port, park };
}

describe("parkImplementerAtExit", () => {
  it("parks a spawned implementer's tree", async () => {
    const { port, park } = implementerPort("impl-a");

    expect(await parkImplementerAtExit(port, "id-impl-a")).toEqual({
      action: "parked",
      name: "impl-a",
    });
    expect(park).toHaveBeenCalledWith("id-impl-a");
  });

  it("passes over a reviewer", async () => {
    const { port, park } = implementerPort("impl-a", {
      current: () => agent("rv-1", { profile: "reviewer" }),
    });

    expect(await parkImplementerAtExit(port, "id-rv-1")).toEqual({
      action: "off",
    });
    expect(park).not.toHaveBeenCalled();
  });

  it("does nothing while autoPark is off", async () => {
    const { port, park } = implementerPort("impl-a", { enabled: () => false });

    expect(await parkImplementerAtExit(port, "id-impl-a")).toEqual({
      action: "off",
    });
    expect(park).not.toHaveBeenCalled();
  });

  it("keeps a tree a burndown claim still reads", async () => {
    const { port, park } = implementerPort("impl-a", {
      treeHold: () => "claim reads the tree",
    });

    expect(await parkImplementerAtExit(port, "id-impl-a")).toEqual({
      action: "kept",
      name: "impl-a",
      reason: "claim reads the tree",
    });
    expect(park).not.toHaveBeenCalled();
  });

  it("does nothing for an adopted tree", async () => {
    const { port } = implementerPort("impl-a", {
      events: () => [
        allocated("impl-a", "b", realTree(), { assigned: "true" }),
      ],
    });

    expect(await parkImplementerAtExit(port, "id-impl-a")).toEqual({
      action: "off",
    });
  });

  it("keeps the tree with the park's reason when the park refuses", async () => {
    const { port } = implementerPort("impl-a", {
      park: async () => ({ ok: false, reason: "dirty" }),
    });

    expect(await parkImplementerAtExit(port, "id-impl-a")).toEqual({
      action: "kept",
      name: "impl-a",
      reason: "dirty",
    });
  });

  it("never rejects and names the agent by id when it cannot be read", async () => {
    const { port } = implementerPort("impl-a", {
      current: () => {
        throw new Error("roster gone");
      },
    });

    expect(await parkImplementerAtExit(port, "id-impl-a")).toEqual({
      action: "kept",
      name: "id-impl-a",
      reason: "roster gone",
    });
  });
});

describe("parkReviewerAtReport", () => {
  it("parks a reviewer whose last report is a Verdict", async () => {
    const { port, park } = reviewerPort(
      {},
      { report: "Verdict: MERGE\nPR: example/repo#1" }
    );

    expect(await parkReviewerAtReport(port, "id-rv-1")).toEqual({
      action: "parked",
      name: "rv-1",
    });
    expect(park).toHaveBeenCalledOnce();
  });

  it("parks a reviewer whose Verdict follows a lead-in paragraph in its final text", async () => {
    const { port } = reviewerPort(
      {},
      { final: "Looked at the diff.\n\nVerdict: MERGE" }
    );

    expect((await parkReviewerAtReport(port, "id-rv-1")).action).toBe("parked");
  });

  it("keeps a tree when no Verdict was reported", async () => {
    const { port, park } = reviewerPort({}, { report: "Status: IN PROGRESS" });

    expect(await parkReviewerAtReport(port, "id-rv-1")).toEqual({
      action: "kept",
      name: "rv-1",
      reason: NO_VERDICT,
    });
    expect(park).not.toHaveBeenCalled();
  });

  it("passes over an implementer", async () => {
    const { port } = reviewerPort(
      { current: () => agent("impl-a") },
      { report: "Verdict: MERGE" }
    );

    expect(await parkReviewerAtReport(port, "id-impl-a")).toEqual({
      action: "off",
    });
  });

  it("does nothing when the reviewer holds no parkable tree", async () => {
    const { port } = reviewerPort(
      { events: () => [] },
      { report: "Verdict: MERGE" }
    );

    expect(await parkReviewerAtReport(port, "id-rv-1")).toEqual({
      action: "off",
    });
  });
});

describe("isVerdictText", () => {
  it("reads a Verdict line anywhere and a finished Status opening", () => {
    expect(isVerdictText("intro\nVerdict: MERGE")).toBe(true);
    expect(isVerdictText("Status: DONE")).toBe(true);
    expect(isVerdictText("the verdict is pending")).toBe(false);
  });
});
