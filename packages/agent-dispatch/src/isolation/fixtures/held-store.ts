import type { Allocation } from "../strategy.js";
import type { HeldAllocation, HeldAllocationStore } from "../sweep.js";

export interface MemoryStore extends HeldAllocationStore {
  record(agentId: string, allocation: Allocation): void;
}

/** The host's record of allocations, held in memory. */
export function memoryStore(): MemoryStore {
  const byAgent = new Map<string, Allocation>();
  const held = (): Map<string, HeldAllocation> =>
    new Map(
      [...byAgent].map(([agentId, allocation]) => [allocation.ref?.["branch"] ?? "", { agentId, allocation }]),
    );
  return {
    held,
    forget: (agentId) => void byAgent.delete(agentId),
    record: (agentId, allocation) => void byAgent.set(agentId, allocation),
  };
}
