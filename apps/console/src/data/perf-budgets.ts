/** Mirrors the plan's initial budgets table until the server's budget table (TP-4426) is shared with the client. */
interface LocalBudget {
  maxMs: number;
  maxBytes: number;
}

const KB = 1024;

const DEFAULT_RPC_BUDGET: LocalBudget = { maxMs: 200, maxBytes: 256 * KB };

const LOCAL_RPC_BUDGETS: Record<string, LocalBudget> = {
  "inbox.list": { maxMs: 300, maxBytes: 150 * KB },
  "approvals.flow": { maxMs: 300, maxBytes: 800 * KB },
  "work.portfolio": { maxMs: 250, maxBytes: 64 * KB },
  "work.tasks": { maxMs: 500, maxBytes: 1800 * KB },
  "work.task": { maxMs: 300, maxBytes: 128 * KB },
  "work.initiative": { maxMs: 250, maxBytes: 600 * KB },
  "work.notes": { maxMs: 300, maxBytes: 1200 * KB },
  "graph.ego": { maxMs: 300, maxBytes: 64 * KB },
  "rounds.list": { maxMs: 150, maxBytes: 100 * KB },
  "rounds.get": { maxMs: 100, maxBytes: 64 * KB },
  "shepherd.list": { maxMs: 150, maxBytes: 256 * KB },
  "autoresearch.runs": { maxMs: 100, maxBytes: 64 * KB },
};

/** Plan §2: no page waits longer than this for its first data. */
const LOCAL_ROUTE_BUDGET_MS = 3000;

function localRpcBudget(name: string): LocalBudget {
  return LOCAL_RPC_BUDGETS[name] ?? DEFAULT_RPC_BUDGET;
}

export function rpcOverBudget(row: { name: string; p95: number; bytesMax: number }): boolean {
  const budget = localRpcBudget(row.name);
  return row.p95 > budget.maxMs || row.bytesMax > budget.maxBytes;
}

export function routeOverBudget(row: { p95: number }): boolean {
  return row.p95 > LOCAL_ROUTE_BUDGET_MS;
}
