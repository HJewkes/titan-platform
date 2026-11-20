import { describe, expect, it } from "vitest";
import type { ActiveWork, ReadName, ReadResult } from "./active-work.js";
import { keepWarm } from "./keep-warm.js";

interface Recorded {
  reads: Array<[string, unknown]>;
  activeWork: ActiveWork;
  inbox: Parameters<typeof keepWarm>[0]["inbox"];
  shepherd: Parameters<typeof keepWarm>[0]["shepherd"];
  warned: string[];
}

/** Records every upstream read the primer makes; `failing` names reads that reject. */
function recorded(failing: readonly string[] = [], override?: (name: string) => Promise<unknown> | undefined): Recorded {
  const reads: Array<[string, unknown]> = [];
  const answer = (name: string, args?: unknown): Promise<unknown> => {
    reads.push([name, args]);
    if (failing.includes(name)) return Promise.reject(new Error(`${name} down`));
    const overridden = override?.(name);
    if (overridden !== undefined) return overridden;
    return Promise.resolve(name === "list" ? { sections: [{ items: [{ slug: "alpha" }, { slug: "beta" }] }] } : {});
  };
  function read<K extends ReadName>(command: K, args?: Record<string, unknown>): Promise<ReadResult<K>>;
  function read(command: ReadName, args?: Record<string, unknown>): Promise<unknown> {
    return answer(command, args);
  }
  const warned: string[] = [];
  const inbox = {
    factory: { list: () => answer("needs.list") },
    finished: { read: () => answer("shepherd.list finished") },
    strips: { warm: (rows: readonly unknown[], limit: number) => answer("strips.warm", { rows, limit }).then(() => undefined) },
    shown: () => answer("inbox.shown"),
  };
  const shepherd = { list: (scope: string) => answer("shepherd.list", scope).then(() => []) };
  return { reads, activeWork: { read }, inbox, shepherd, warned };
}

function primer(sources: Recorded) {
  return keepWarm({ activeWork: sources.activeWork, inbox: sources.inbox, shepherd: sources.shepherd, logger: { warn: (_fields, message) => void sources.warned.push(message) } });
}

const WHOLE_TREE: Array<[string, unknown]> = [
  ["list", {}],
  ["inventory", {}],
  ["task.list", { all_initiatives: true }],
  ["artifact.list", { all_initiatives: true }],
];
const BRIEFS: Array<[string, unknown]> = [
  ["source.read", { slug: "alpha", path: "brief.md" }],
  ["source.read", { slug: "beta", path: "brief.md" }],
];
const INBOX: Array<[string, unknown]> = [
  ["needs.list", undefined],
  ["shepherd.list finished", undefined],
  ["shepherd.list", "active"],
  ["inbox.shown", undefined],
  ["strips.warm", { rows: [], limit: 6 }],
];

const sorted = (reads: Array<[string, unknown]>): string[] => reads.map((read) => JSON.stringify(read)).sort();

describe("keepWarm", () => {
  it("serve start reads each whole-tree read once", async () => {
    const sources = recorded();

    await primer(sources).prime();

    expect(sorted(sources.reads)).toEqual(sorted([...WHOLE_TREE, ...INBOX, ...BRIEFS]));
  });

  it("a reconnected factory re-primes needs.list and finished runs", async () => {
    const sources = recorded();
    const warm = primer(sources);

    await warm.reconnected("factory");
    const afterFactory = [...sources.reads];
    await warm.reconnected("agent-chat");

    expect(afterFactory).toEqual(INBOX);
    expect(sources.reads).toEqual(INBOX);
  });

  it("a reconnected active-work re-primes only the whole-tree reads", async () => {
    const sources = recorded();

    await primer(sources).reconnected("active-work");

    expect(sorted(sources.reads)).toEqual(sorted([...WHOLE_TREE, ...BRIEFS]));
  });

  it("the portfolio's brief reads never exceed six in flight", async () => {
    let inFlight = 0;
    let peak = 0;
    const slugs = Array.from({ length: 20 }, (_, index) => ({ slug: `s${index}` }));
    const sources = recorded([], (name) => {
      if (name === "list") return Promise.resolve({ sections: [{ items: slugs }] });
      if (name !== "source.read") return undefined;
      inFlight++;
      peak = Math.max(peak, inFlight);
      return new Promise((resolve) => setTimeout(() => {
        inFlight--;
        resolve({});
      }, 1));
    });

    await primer(sources).reconnected("active-work");

    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(6);
  });

  it("a failed brief read is logged and never rejects the pass", async () => {
    const sources = recorded(["source.read"]);

    await expect(primer(sources).reconnected("active-work")).resolves.toBeUndefined();

    expect(sources.warned).toHaveLength(1);
  });

  it("a failed list read skips the brief reads and is logged", async () => {
    const sources = recorded(["list"]);

    await primer(sources).reconnected("active-work");

    expect(sources.reads.filter(([name]) => name === "source.read")).toEqual([]);
    expect(sources.warned).toHaveLength(1);
  });

  it("a failed active-run list skips the strips and is logged", async () => {
    const sources = recorded(["shepherd.list"]);

    await primer(sources).reconnected("factory");

    expect(sources.reads.map(([name]) => name)).not.toContain("strips.warm");
    expect(sources.warned).toHaveLength(1);
  });

  it("a failed read is logged once per pass and never rejects the pass", async () => {
    const sources = recorded(["inventory", "needs.list"]);

    await expect(primer(sources).prime()).resolves.toBeUndefined();

    expect(sources.reads).toHaveLength(11);
    expect(sources.warned).toHaveLength(1);
  });

  it("serve start reads the rows the inbox shows, so its merge rows' lineage is kept before the first page", async () => {
    const sources = recorded();

    await primer(sources).prime();

    expect(sources.reads.map(([name]) => name)).toContain("inbox.shown");
  });

  it("serve start reads the task page's git and GitHub evidence for every repo the artifacts name", async () => {
    const artifacts = { items: [{ artifacts: { branches: [{ repo: "/synthetic/alpha" }], worktrees: [{ repo: "/synthetic/beta" }] } }] };
    const sources = recorded([], (name) => (name === "artifact.list" ? Promise.resolve(artifacts) : undefined));
    const evidence: string[][] = [];

    const reader = async (paths: readonly string[]) => {
      evidence.push([...paths]);
      return [];
    };

    await keepWarm({ activeWork: sources.activeWork, inbox: sources.inbox, shepherd: sources.shepherd, evidence: reader, logger: { warn: () => undefined } }).prime();

    expect(evidence).toEqual([["/synthetic/alpha", "/synthetic/beta"]]);
  });
});
