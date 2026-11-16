import { describe, expect, it } from "vitest";
import type { ActiveWork, ReadName, ReadResult } from "./active-work.js";
import { keepWarm } from "./keep-warm.js";

interface Recorded {
  reads: Array<[string, unknown]>;
  activeWork: ActiveWork;
  inbox: Parameters<typeof keepWarm>[0]["inbox"];
  warned: string[];
}

/** Records every upstream read the primer makes; `failing` names reads that reject. */
function recorded(failing: readonly string[] = []): Recorded {
  const reads: Array<[string, unknown]> = [];
  const answer = (name: string, args?: unknown): Promise<unknown> => {
    reads.push([name, args]);
    return failing.includes(name) ? Promise.reject(new Error(`${name} down`)) : Promise.resolve({});
  };
  function read<K extends ReadName>(command: K, args?: Record<string, unknown>): Promise<ReadResult<K>>;
  function read(command: ReadName, args?: Record<string, unknown>): Promise<unknown> {
    return answer(command, args);
  }
  const warned: string[] = [];
  const inbox = {
    factory: { list: () => answer("needs.list") },
    finished: { read: () => answer("shepherd.list finished") },
  };
  return { reads, activeWork: { read }, inbox, warned };
}

function primer(sources: Recorded) {
  return keepWarm({ activeWork: sources.activeWork, inbox: sources.inbox, logger: { warn: (_fields, message) => void sources.warned.push(message) } });
}

const WHOLE_TREE: Array<[string, unknown]> = [
  ["list", {}],
  ["inventory", {}],
  ["task.list", { all_initiatives: true }],
  ["artifact.list", { all_initiatives: true }],
];
const INBOX: Array<[string, unknown]> = [
  ["needs.list", undefined],
  ["shepherd.list finished", undefined],
];

describe("keepWarm", () => {
  it("serve start reads each whole-tree read once", async () => {
    const sources = recorded();

    await primer(sources).prime();

    expect(sources.reads).toEqual([...WHOLE_TREE, ...INBOX]);
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

    expect(sources.reads).toEqual(WHOLE_TREE);
  });

  it("a failed read is logged once per pass and never rejects the pass", async () => {
    const sources = recorded(["inventory", "needs.list"]);

    await expect(primer(sources).prime()).resolves.toBeUndefined();

    expect(sources.reads).toHaveLength(6);
    expect(sources.warned).toHaveLength(1);
  });
});
