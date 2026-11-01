import { describe, expect, it } from "vitest";
import {
  fileOwnershipStrategy,
  isWarning,
  matchPattern,
  noneStrategy,
  refusalsIn,
  toolsetStrategy,
  type IsolationContext,
  type LivePeer,
} from "./index.js";

const ctxFor = (cwd: string, overrides: Partial<IsolationContext> = {}): IsolationContext => ({
  agentId: "ag-1",
  agentName: "alice",
  baseCwd: cwd,
  ...overrides,
});

const peer = (name: string, cwd: string, claims?: string[]): LivePeer => ({
  agentId: `ag-${name}`,
  name,
  cwd,
  ...(claims ? { claims } : {}),
});

describe("none", () => {
  it("warns about agents already in the same checkout without refusing", async () => {
    const ctx = ctxFor("/repo", { peers: [peer("bob", "/repo")] });

    const reasons = await noneStrategy.check(ctx);

    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain("bob");
    expect(refusalsIn(reasons)).toEqual([]);
  });

  it("says nothing about agents in other checkouts", async () => {
    const ctx = ctxFor("/repo", { peers: [peer("bob", "/elsewhere")] });

    expect(await noneStrategy.check(ctx)).toEqual([]);
  });

  it("leaves the agent in the shared checkout and releases cleanly", async () => {
    const alloc = await noneStrategy.allocate(ctxFor("/repo"));

    expect(alloc).toEqual({ cwd: "/repo" });
    expect(await noneStrategy.release(ctxFor("/repo"), alloc)).toBe(true);
  });
});

describe("toolset-limited", () => {
  it("carries the profile tool lists into the allocation", async () => {
    const ctx = ctxFor("/repo", {
      toolset: { allowedTools: ["Read", "Grep"], disallowedTools: ["Bash"] },
    });

    const alloc = await toolsetStrategy.allocate(ctx);

    expect(alloc.cwd).toBe("/repo");
    expect(alloc.allowedTools).toEqual(["Read", "Grep"]);
    expect(alloc.disallowedTools).toEqual(["Bash"]);
    expect(alloc.note).toContain("Read, Grep");
    expect(alloc.note).toContain("Bash are unavailable");
  });

  it("warns when it would restrict nothing", async () => {
    const reasons = await toolsetStrategy.check(ctxFor("/repo"));

    expect(reasons.every(isWarning)).toBe(true);
    expect(reasons).toHaveLength(1);
  });

  // An allow list alone confines nothing, because the agent still inherits
  // settings that may grant Bash.
  it("still warns when an allow list is present but nothing is denied", async () => {
    const ctx = ctxFor("/repo", { toolset: { allowedTools: ["Read", "Grep", "Glob"] } });

    const reasons = await toolsetStrategy.check(ctx);

    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain("disallowedTools");
  });

  it("goes quiet only once a deny list is actually present", async () => {
    const ctx = ctxFor("/repo", { toolset: { allowedTools: ["Read"], disallowedTools: ["Bash"] } });

    expect(await toolsetStrategy.check(ctx)).toEqual([]);
  });

  // An agent that believes it cannot report back does not report back.
  it("tells the agent it can still chat, which the profile list alone does not say", async () => {
    const ctx = ctxFor("/repo", {
      toolset: { allowedTools: ["Read", "Grep", "Glob"], disallowedTools: ["Bash"] },
    });

    const alloc = await toolsetStrategy.allocate(ctx);

    expect(alloc.note).toContain("chat_send");
    expect(alloc.note).toContain("ToolSearch");
    expect(alloc.note).not.toMatch(/limited to: Read, Grep, Glob\.?$/);
  });
});

describe("file-ownership patterns", () => {
  it("matches directory prefixes, single-segment and multi-segment globs", () => {
    expect(matchPattern("src/cli/agent.ts", "src/cli/")).toBe(true);
    expect(matchPattern("src/cli", "src/cli/")).toBe(true);
    expect(matchPattern("src/server/x.ts", "src/cli/")).toBe(false);
    expect(matchPattern("src/cli/agent.ts", "src/*/agent.ts")).toBe(true);
    expect(matchPattern("src/a/b/agent.ts", "src/*/agent.ts")).toBe(false);
    expect(matchPattern("src/a/b/agent.ts", "src/**/agent.ts")).toBe(true);
    expect(matchPattern("package.json", "package.json")).toBe(true);
    expect(matchPattern("src/agents/isolation/x.ts", "src/agents/**")).toBe(true);
    expect(matchPattern("src/server/x.ts", "src/agents/**")).toBe(false);
  });
});

describe("file-ownership strategy", () => {
  const claimant = ctxFor("/repo", {
    declaredPaths: ["src/agents/isolation/x.ts"],
    peers: [peer("bob", "/repo", ["src/agents/isolation/**"])],
  });

  it("warns by default when a claim overlaps a live peer", async () => {
    const reasons = await fileOwnershipStrategy.check(claimant);

    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain("bob");
    expect(refusalsIn(reasons)).toEqual([]);
  });

  it("refuses the same overlap under strict", async () => {
    const reasons = await fileOwnershipStrategy.check({ ...claimant, strict: true });

    expect(refusalsIn(reasons)).toHaveLength(1);
  });

  it("treats a claim as a lease on presence: a disconnected peer blocks nothing", async () => {
    const ctx = ctxFor("/repo", {
      declaredPaths: ["src/agents/isolation/x.ts"],
      peers: [],
      strict: true,
    });

    expect(await fileOwnershipStrategy.check(ctx)).toEqual([]);
  });

  it("ignores claims from peers working in another checkout", async () => {
    const ctx = {
      ...claimant,
      peers: [peer("bob", "/other", ["src/agents/isolation/**"])],
      strict: true,
    };

    expect(await fileOwnershipStrategy.check(ctx)).toEqual([]);
  });

  // The asymmetry is the point: a declared FILE under a peer's glob is caught
  // above, the reverse is not, and that holds only while the manifest is
  // coordinator-issued.
  it("does not see a declared glob that swallows a live concrete claim (CC-92)", async () => {
    const ctx = ctxFor("/repo", {
      declaredPaths: ["src/agents/**"],
      peers: [peer("bob", "/repo", ["src/agents/isolation/x.ts"])],
      strict: true,
    });

    expect(await fileOwnershipStrategy.check(ctx)).toEqual([]);
  });

  it("puts the ownership brief in the allocation without moving the agent", async () => {
    const alloc = await fileOwnershipStrategy.allocate(claimant);

    expect(alloc.cwd).toBe("/repo");
    expect(alloc.note).toContain("src/agents/isolation/x.ts");
    expect(alloc.note).toContain("Read-only");
    expect(await fileOwnershipStrategy.release(claimant, alloc)).toBe(true);
  });
});
