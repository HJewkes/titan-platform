---
"@titan-design/agent-protocol": minor
---

agent-protocol: `reduceExecutionTransition` takes an optional `ExecutionReducerOptions` whose `fencing: { kind: "supervisor", lease }` fences transitions by a supervisor-wide lease, stamps accepted writes with it, and refuses per-row owner transitions (TP-192 S4). The default mode is unchanged.
