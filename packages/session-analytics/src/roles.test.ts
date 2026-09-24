import { describe, expect, it } from "vitest";
import { classifySession } from "./classify-session.js";
import { assignmentCount, buildEpisodes } from "./episodes.js";
import { roleFromProfile, sessionRole, workerRole } from "./roles.js";

const HOUR_MS = 3_600_000;

describe("worker roles", () => {
  it("maps profiles to roles by the worker report's table", () => {
    const table: Record<string, string> = {
      implementer: "implementer",
      "implementer-lite": "implementer",
      "relay-implementer": "implementer",
      "beat-builder": "implementer",
      "fable-optimizer": "implementer",
      reviewer: "reviewer",
      "relay-reviewer": "reviewer",
      researcher: "researcher",
      explorer: "researcher",
      "fable-architect": "planner",
      peer: "standing_peer",
    };

    for (const [profile, role] of Object.entries(table)) expect(roleFromProfile(profile), profile).toBe(role);
    expect(roleFromProfile("Reviewer")).toBe("reviewer");
    expect(roleFromProfile("designer")).toBe("unknown");
    expect(roleFromProfile(null)).toBe("unknown");
  });

  it("reclassifies a worker that lives past 12 hours with 2 or more episodes as standing_peer", () => {
    const reviewer = { profile: "reviewer", lifetimeMs: 12 * HOUR_MS, assignments: 2 };

    expect(workerRole(reviewer)).toBe("standing_peer");
    expect(workerRole({ ...reviewer, lifetimeMs: 12 * HOUR_MS - 1 })).toBe("reviewer");
    expect(workerRole({ ...reviewer, assignments: 1 })).toBe("reviewer");
    expect(workerRole({ profile: "peer", lifetimeMs: 0, assignments: 1 })).toBe("standing_peer");
  });

  it("counts only episodes an assignment opened, so an idle worker is not a standing peer", () => {
    const day = (hour: number) => `2026-09-20T${String(hour).padStart(2, "0")}:00:00Z`;
    const idle = buildEpisodes(
      {
        requests: [
          { offset: 2, ts: day(0), transcriptId: 1, contextTokens: 0, wakeCause: null },
          { offset: 3, ts: day(13), transcriptId: 1, contextTokens: 0, wakeCause: null },
        ],
        inbounds: [{ offset: 1, ts: day(0), transcriptId: 1, cause: "human_typed" }],
        signals: [],
        spawned: true,
      },
      "worker-v1",
    );

    expect(idle.map((row) => row.openedBy)).toEqual(["brief", "idle_gap"]);
    expect(workerRole({ profile: "implementer", lifetimeMs: 13 * HOUR_MS, assignments: assignmentCount(idle) })).toBe("implementer");
  });

  it("keys the report's role by human role, worker role, or class", () => {
    const worker = { profile: "fable-architect", lifetimeMs: 0, assignments: 1 };
    const spawned = classifySession({ origin: { depth: 1, profile: "fable-architect" } });
    const coordinator = classifySession({ inboundKinds: ["channel_message"] });
    const headless = classifySession({ startType: "sdk-cli" });

    expect(sessionRole(spawned, worker)).toBe("worker:planner");
    expect(sessionRole(coordinator, worker)).toBe("coordinator");
    expect(sessionRole(headless, worker)).toBe("headless_sdk");
  });
});
