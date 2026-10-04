export { ACTION_CLASSES, ACTOR_CLASSES, CONDITION_KINDS, EVIDENCE_KINDS, RESOLVER_CLASSES, VERDICTS } from "./vocabulary.js";
export type { ActionClass, ActorClass, ConditionKind, EvidenceKind, ResolverClass, Verdict } from "./vocabulary.js";
export { unmetConditions } from "./conditions.js";
export type { AgentIdentity, CarryFact, CheckRunFact, ConditionFacts, MergeFacts } from "./conditions.js";
export { policyTableSchema } from "./schema.js";
export type { PolicyTable, Rule } from "./schema.js";
export { evaluate, canResolve } from "./evaluate.js";
export type { AuthorityRequest, Decision } from "./evaluate.js";
export { DEFAULT_TABLE } from "./table.js";
