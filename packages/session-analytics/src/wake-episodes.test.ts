import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { costReport, type CostReport } from "./cost-report.js";
import { WAKE_WINDOW, createFixtureGraph, seedWakeScenario, type FixtureGraph } from "./fixture.js";
import { priceRequest } from "./price-request.js";
import { buildWakeEpisodes, episodeNames, fromKindOf, summarizeWakeEpisodes, type WakeEpisode, type WakeEpisodes } from "./wake-episodes.js";

let fixture: FixtureGraph;
let episodes: WakeEpisodes;

beforeEach(() => {
  fixture = createFixtureGraph();
  seedWakeScenario(fixture);
  episodes = costReport(fixture.openReadOnly(), WAKE_WINDOW).wakeEpisodes;
});
afterEach(() => fixture.close());

/** Every scenario request is output-only on one model, so cost is linear in output tokens. */
const outputCost = (tokens: number) => priceRequest({ outputTokens: tokens }, "claude-opus-5", "2026-09-22T00:00:00Z").costUsd;
const cause = (key: string) => episodes.byCause.find((bucket) => bucket.key === key)!;
const reportWith = (options: Parameters<typeof costReport>[1]): CostReport => costReport(fixture.openReadOnly(), { ...WAKE_WINDOW, ...options });

describe("wakeEpisodes", () => {
  it("reports requests and cost per episode for each wake cause of the coordinator roles", () => {
    const channel = cause("channel_message");

    expect(episodes.roles).toEqual(["coordinator", "worker:coordinator"]);
    expect(episodes).toMatchObject({ episodes: 6, requests: 7 });
    expect(channel).toMatchObject({ episodes: 4, requests: 4, requestsPerEpisode: 1 });
    expect(channel.costUsd).toBeCloseTo(outputCost(3_000), 10);
    expect(channel.costPerEpisode).toBeCloseTo(outputCost(750), 10);
    expect(cause("human_typed")).toMatchObject({ episodes: 1, requests: 2, requestsPerEpisode: 2 });
  });

  it("counts mid-loop deliveries as episodes, including a burst arrival no request followed", () => {
    expect(cause("channel_message").midLoopEpisodes).toBe(2);
    expect(cause("agent_lifecycle").midLoopEpisodes).toBe(1);
    expect(cause("channel_message").byFrom.find((from) => from.key === "broadcast")).toMatchObject({ episodes: 1, requests: 0 });
  });

  it("a tool result inside a wake keeps its requests in the same episode", () => {
    expect(cause("human_typed").costPerEpisode).toBeCloseTo(outputCost(4_000), 10);
    expect(episodes.byCause.map((bucket) => bucket.key)).not.toContain("tool_result");
  });

  it("reports the agent lifecycle notice as its own wake cause, sent by the broker", () => {
    expect(cause("agent_lifecycle")).toMatchObject({ episodes: 1, requests: 1, byFrom: [expect.objectContaining({ key: "broker" })] });
    expect(episodes.byCause.map((bucket) => bucket.key)).not.toContain("channel_system");
  });

  it("flags a wake no-action when its requests only read, answer in text or call unnamed tools", () => {
    const channel = cause("channel_message");

    expect(episodes).toMatchObject({ noActionEpisodes: 3 });
    expect(episodes.noActionCostUsd).toBeCloseTo(outputCost(1_800), 10);
    expect(channel.byFrom.find((from) => from.key === "agent")).toMatchObject({ noActionEpisodes: 1 });
    expect(channel.byFrom.find((from) => from.key === "seat")).toMatchObject({ episodes: 2, noActionEpisodes: 1 });
    expect(cause("agent_lifecycle").noActionEpisodes).toBe(0);
    expect(cause("human_typed").noActionEpisodes).toBe(0);
  });

  it("a caller's noActionClasses list decides the flag", () => {
    const lenient = reportWith({ noActionClasses: ["read-investigate", "text-only", "other", "pr-ci-check"] }).wakeEpisodes;

    expect(lenient.noActionClasses).toContain("pr-ci-check");
    expect(lenient.byCause.find((bucket) => bucket.key === "agent_lifecycle")!.noActionEpisodes).toBe(1);
  });

  it("splits each cause by sender kind and pairs every sender with its receiver", () => {
    expect(cause("channel_message").byFrom.map((from) => from.key).sort()).toEqual(["agent", "broadcast", "seat"]);
    expect(episodes.pairs.map(({ from, fromKind, to, episodes: n }) => ({ from, fromKind, to, n }))).toEqual(
      expect.arrayContaining([
        { from: "agent", fromKind: "agent", to: "seat-a", n: 1 },
        { from: "seat-b", fromKind: "seat", to: "seat-a", n: 1 },
        { from: "seat-b", fromKind: "broadcast", to: "seat-a", n: 1 },
        { from: "seat-a", fromKind: "seat", to: "seat-b", n: 1 },
        { from: "broker", fromKind: "broker", to: "seat-a", n: 1 },
      ]),
    );
    expect(episodes.pairs).toHaveLength(5);
  });

  it("leaves other roles out and counts requests an earlier arrival started as unattributed", () => {
    expect(episodes.pairs.map((pair) => pair.to)).not.toContain("impl");
    expect(episodes.unattributed.requests).toBe(1);
    expect(episodes.unattributed.costUsd).toBeCloseTo(outputCost(100), 10);
    expect(reportWith({ episodeRoles: ["worker:implementer"] }).wakeEpisodes).toMatchObject({ episodes: 1, requests: 1 });
  });
});

describe("episode names", () => {
  const names = episodeNames([
    { sessionId: "s1", agentName: "seat-top", originKind: "adopted", profile: null },
    { sessionId: "s2", agentName: "seat-spawned", originKind: "spawned", profile: "opus-coordinator" },
    { sessionId: "s3", agentName: "worker-1", originKind: "spawned", profile: "implementer" },
  ]);
  const event = { key: "1:1", sessionId: "s1", cause: "channel_message", delivery: "turn_start", broadcast: false };

  it("a top-level session or a coordinator-profile spawn is a seat; any other sender is an agent", () => {
    expect([...names.seats].sort()).toEqual(["seat-spawned", "seat-top"]);
    expect(fromKindOf({ ...event, fromName: "seat-spawned" }, names.seats)).toBe("seat");
    expect(fromKindOf({ ...event, fromName: "worker-1" }, names.seats)).toBe("agent");
    expect(fromKindOf({ ...event, fromName: "never-registered" }, names.seats)).toBe("agent");
  });

  it("a broadcast outranks the sender's kind, and an arrival with no sender is none", () => {
    expect(fromKindOf({ ...event, fromName: "seat-top", broadcast: true }, names.seats)).toBe("broadcast");
    expect(fromKindOf({ ...event, cause: "human_typed", fromName: null }, names.seats)).toBe("none");
  });

  it("an episode with no requests is no-action and names its receiver", () => {
    const [episode] = buildWakeEpisodes([{ ...event, fromName: "worker-1" }], [], names, ["text-only"]);

    expect(episode).toMatchObject({ requests: 0, costUsd: 0, noAction: true, to: "seat-top", from: "agent" });
  });
});

describe("pair ordering", () => {
  const episode = (fromKind: WakeEpisode["fromKind"]): WakeEpisode => ({ key: fromKind, cause: "channel_message", midLoop: false, fromKind, from: "seat-b", to: "seat-a", requests: 1, costUsd: 1, noAction: false });
  const kindsFor = (list: WakeEpisode[]) => summarizeWakeEpisodes(list, [], [], []).pairs.map((pair) => pair.fromKind);

  it("orders pairs tied on cost, sender and receiver by sender kind, whatever the input order", () => {
    const seat = episode("seat");
    const broadcast = episode("broadcast");

    expect(kindsFor([seat, broadcast])).toEqual(["broadcast", "seat"]);
    expect(kindsFor([broadcast, seat])).toEqual(["broadcast", "seat"]);
  });
});
