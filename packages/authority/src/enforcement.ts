import { z } from "zod";

/**
 * What enforces one table row. A titan-platform mechanism names a file from the repo root and an exported symbol
 * rather than a line, so a test can tell a stale citation from a right one. Other repos, the owner's local
 * git-safety hook and remote settings are format-checked only.
 */
export type Enforcement =
  | { kind: "mechanism"; repo: "titan-platform"; path: string; symbol: string }
  | { kind: "mechanism"; repo: "agent-chat" | "voltras-mcp" | "git-safety" | "remote"; ref: string }
  | { kind: "task"; id: string }
  | { kind: "inherent"; reason: string };

const TASK_ID = /^(TP|CC|VW|R)-\d+[a-z]?$/;
const REF = /^[\w./:-]+(#[\w-]+)?$/;

const citationSchema: z.ZodType<Enforcement> = z.union([
  z.object({ kind: z.literal("mechanism"), repo: z.literal("titan-platform"), path: z.string().regex(/^[\w./-]+$/), symbol: z.string().regex(/^[\w-]+$/) }).strict(),
  z.object({ kind: z.literal("mechanism"), repo: z.enum(["agent-chat", "voltras-mcp", "git-safety", "remote"]), ref: z.string().regex(REF) }).strict(),
  z.object({ kind: z.literal("task"), id: z.string().regex(TASK_ID) }).strict(),
  z.object({ kind: z.literal("inherent"), reason: z.string().min(1) }).strict(),
]);

/** Validates the citation map's shape; which rows it covers is checked against the table by its test. */
export const enforcementSchema = z.record(z.string().min(1), z.array(citationSchema).min(1));

const tp = (path: string, symbol: string): Enforcement => ({ kind: "mechanism", repo: "titan-platform", path, symbol });
const ac = (ref: string): Enforcement => ({ kind: "mechanism", repo: "agent-chat", ref });
const vm = (ref: string): Enforcement => ({ kind: "mechanism", repo: "voltras-mcp", ref });
const gs = (ref: string): Enforcement => ({ kind: "mechanism", repo: "git-safety", ref });
const remote = (ref: string): Enforcement => ({ kind: "mechanism", repo: "remote", ref });
const task = (id: string): Enforcement => ({ kind: "task", id });
const inherent = (reason: string): Enforcement => ({ kind: "inherent", reason });

const GUARD = tp("packages/tool-guard/src/decide.ts", "decide");
const GH_MERGE = tp("packages/tool-guard/src/families/merge.ts", "ghPrMerge");
const VERSION_PACKAGES = tp("packages/tool-guard/src/families/merge.ts", "VERSION_PACKAGES_RE");
const RELEASE = tp("packages/tool-guard/src/families/release.ts", "release");
const SECRET = tp("packages/tool-guard/src/families/secret.ts", "secret");
const CONFIG = tp("packages/tool-guard/src/families/config.ts", "config");
const GUARDED = tp("packages/tool-guard/src/paths.ts", "GUARDED_PATHS");
const HTTP = tp("packages/tool-guard/src/families/egress.ts", "httpRequest");
const AUTO_MERGE = tp("products/factory/src/shepherd/merge-facts.ts", "decideAutoMerge");
const CONDITIONS = tp("packages/authority/src/conditions.ts", "unmetConditions");
const CAN_RESOLVE = tp("packages/authority/src/evaluate.ts", "canResolve");
const DEFAULT_REFUSAL = tp("packages/hitl/src/resolver-policy.ts", "defaultResolverRefusal");
const RULE_REFUSAL = tp("packages/hitl/src/resolver-policy.ts", "ruleResolverRefusal");
const WORKFLOW_GATE = tp("packages/workflow/src/authorize.ts", "authorityOutcome");
const DEVICE_GATE = tp("products/factory/src/device-gates.ts", "deviceGateAuthorize");
const SCAN_RULES = tp("packages/egress-scan/src/rules.ts", "RULE_IDS");
const SCAN_JOB = tp(".github/workflows/ci.yml", "egress-scan");
const REDACT = tp("packages/queue-mirror/src/redact.ts", "redactPreview");
const AGENT_ENV = tp("packages/agent/src/env.ts", "prepareEnv");
const UNLOCK = tp("packages/decider/src/unlock.ts", "checkUnlock");
const DECIDABLE = tp("packages/decider/src/unlock.ts", "DECIDABLE_CATEGORIES");

const HUMAN_FRAMES = ac("src/broker/socket.ts");
const HUMAN_VERBS = ac("src/agents/profiles.ts#BUILTIN_PROFILES");
const ENDORSED = ac("src/protocol.ts");
const SPAWN = ac("src/agents/supervisor.ts");
const SPAWN_RATE = ac("src/agents/spawn-rate.ts#SPAWN_RATE_WINDOW_MS");
const SPAWN_CWD = ac("src/agents/spawn-cwd.ts#SENSITIVE_DIRS");
const ENV_SCRUB = ac("src/agents/agent-env.ts#isSecretName");
const DECISION = ac("src/broker/decisions.ts#checkDecision");
const LEASE = vm("src/lease-guard.ts#applyLeaseGuard");
const STOP_EXEMPT = vm("src/lease-guard.ts#LEASE_EXEMPT_TOOLS");
const GIT_RULES = gs("lib/git-rules.mjs");
const GIT_BYPASS = gs("lib/hook.mjs");
const RULESET = remote("github-ruleset:main-branch-protection");
const TRUSTED_PUBLISH = remote("npm-trusted-publishing:.github/workflows/release.yml");
const PUSH_PROTECTION = remote("github-push-protection");

/** The decider only answers questions; these keep it off every unlock-table row. */
const DECIDER = [UNLOCK, DECISION] as const;
/** A remote principal unlocks only what the delegated-authority rule names, which is not built yet. */
const RELAY = task("CC-123");
const TAINT = task("CC-167");
const DEVICE = task("VW-569");
const FOREIGN = task("TP-242");
const SPEND_NOTICE = task("TP-379");
const OWNER_JUDGEMENT = inherent("The owner's own judgement at the terminal; nothing narrower to enforce.");

/** One entry per DEFAULT_TABLE rule id, held to the table and to the cited sources by `enforcement.test.ts`. */
export const ENFORCEMENT: Readonly<Record<string, readonly Enforcement[]>> = {
  "MRG-OT": [RULESET],
  "MRG-OR": [RULE_REFUSAL, CAN_RESOLVE, RELAY],
  "MRG-CO": [GH_MERGE, GUARD, task("TP-404")],
  "MRG-WK": [GH_MERGE, GUARD],
  "MRG-HD": [GH_MERGE, GUARD],
  "MRG-AU": [WORKFLOW_GATE, AUTO_MERGE],
  "MRG-AU-RV": [tp("products/factory/src/shepherd/merge-facts.ts", "MERGE_BY_REVIEWER_RULE"), CONDITIONS],
  "MRG-AU-RC": [tp("products/factory/src/shepherd/merge-facts.ts", "MERGE_BY_CARRIED_VERDICT_RULE"), CONDITIONS],
  "MRG-AU-RM": [AUTO_MERGE, CONDITIONS],
  "MRG-DC": [...DECIDER],
  "REL-OT": [OWNER_JUDGEMENT],
  "REL-OR": [RELAY],
  "REL-CO": [RELEASE, VERSION_PACKAGES, GUARD, task("TP-404")],
  "REL-WK": [RELEASE, VERSION_PACKAGES, GUARD],
  "REL-HD": [RELEASE, VERSION_PACKAGES, GUARD],
  "REL-AU": [TRUSTED_PUBLISH],
  "REL-DC": [...DECIDER],
  "SEC-OT": [inherent("The OS account is the boundary; the owner's terminal already holds every secret.")],
  "SEC-OR": [RELAY],
  "SEC-CO": [SECRET, GUARDED, GUARD, ENV_SCRUB, AGENT_ENV],
  "SEC-WK": [SECRET, GUARDED, GUARD, ENV_SCRUB, AGENT_ENV],
  "SEC-HD": [SECRET, GUARDED, GUARD, ENV_SCRUB, AGENT_ENV],
  "SEC-AU": [TRUSTED_PUBLISH],
  "SEC-DC": [...DECIDER],
  "UNT-OT": [TAINT],
  "UNT-OR": [ENDORSED, TAINT],
  "UNT-CO": [TAINT],
  "UNT-WK": [TAINT],
  "UNT-HD": [TAINT],
  "UNT-AU": [TAINT],
  "UNT-DC": [...DECIDER, TAINT],
  "PUB-OT": [OWNER_JUDGEMENT],
  "PUB-OR": [RELAY],
  "PUB-CO": [SCAN_RULES, SCAN_JOB, PUSH_PROTECTION],
  "PUB-WK": [SCAN_RULES, SCAN_JOB, PUSH_PROTECTION],
  "PUB-HD": [SCAN_RULES, SCAN_JOB, PUSH_PROTECTION],
  "PUB-AU": [SCAN_RULES, SCAN_JOB],
  "PUB-DC": [...DECIDER, SCAN_JOB],
  "EXT-OT": [OWNER_JUDGEMENT],
  "EXT-OR": [REDACT],
  "EXT-CO": [HTTP, GUARD],
  "EXT-WK": [HTTP, GUARD],
  "EXT-HD": [HTTP, GUARD],
  "EXT-AU": [REDACT],
  "EXT-DC": [...DECIDER],
  "HW-OT": [LEASE],
  "HW-OR": [DEVICE],
  "HW-CO": [DEVICE_GATE, DEVICE],
  "HW-WK": [DEVICE],
  "HW-HD": [DEVICE],
  "HW-AU": [DEVICE],
  "HW-DC": [...DECIDER, DEVICE],
  "HWS-OT": [STOP_EXEMPT],
  "HWS-OR": [STOP_EXEMPT],
  "HWS-CO": [STOP_EXEMPT],
  "HWS-WK": [STOP_EXEMPT],
  "HWS-HD": [STOP_EXEMPT],
  "HWS-AU": [STOP_EXEMPT],
  "HWS-DC": [...DECIDER, DEVICE],
  "DSR-OT": [GIT_BYPASS],
  "DSR-OR": [RELAY],
  "DSR-CO": [GIT_RULES, RULESET],
  "DSR-WK": [GIT_RULES, RULESET],
  "DSR-HD": [GIT_RULES, RULESET],
  "DSR-AU": [RULESET],
  "DSR-DC": [...DECIDER],
  "DSL-OT": [OWNER_JUDGEMENT],
  "DSL-OR": [RELAY],
  "DSL-CO": [GIT_RULES, SPAWN_CWD],
  "DSL-WK": [GIT_RULES, SPAWN_CWD],
  "DSL-HD": [GIT_RULES, SPAWN_CWD],
  "DSL-AU": [GIT_RULES],
  "DSL-DC": [...DECIDER],
  "DSX-OT": [HUMAN_FRAMES],
  "DSX-OR": [RELAY],
  "DSX-CO": [FOREIGN],
  "DSX-WK": [FOREIGN],
  "DSX-HD": [FOREIGN],
  "DSX-AU": [FOREIGN],
  "DSX-DC": [...DECIDER, FOREIGN],
  "SPN-OT": [SPAWN],
  "SPN-OR": [SPAWN, RELAY],
  "SPN-CO": [SPAWN, SPAWN_RATE, SPAWN_CWD],
  "SPN-WK": [SPAWN, HUMAN_VERBS],
  "SPN-HD": [SPAWN, HUMAN_VERBS],
  "SPN-AU": [SPAWN, task("CC-114")],
  "SPN-DC": [...DECIDER],
  "SPD-OT": [OWNER_JUDGEMENT],
  "SPD-OR": [SPEND_NOTICE],
  "SPD-CO": [SPEND_NOTICE],
  "SPD-WK": [SPEND_NOTICE],
  "SPD-HD": [SPEND_NOTICE],
  "SPD-AU": [SPEND_NOTICE],
  "SPD-DC": [...DECIDER, SPEND_NOTICE],
  "CFG-OT": [OWNER_JUDGEMENT],
  "CFG-OR": [RELAY],
  "CFG-CO": [CONFIG, GUARDED, GUARD],
  "CFG-WK": [CONFIG, GUARDED, GUARD],
  "CFG-HD": [CONFIG, GUARDED, GUARD],
  "CFG-AU": [CONFIG, RULESET],
  "CFG-DC": [...DECIDER],
  "HV-OT": [HUMAN_FRAMES],
  "HV-OR": [RULE_REFUSAL, CAN_RESOLVE, RELAY],
  "HV-CO": [DEFAULT_REFUSAL, CAN_RESOLVE, HUMAN_FRAMES, HUMAN_VERBS],
  "HV-WK": [DEFAULT_REFUSAL, CAN_RESOLVE, HUMAN_FRAMES, HUMAN_VERBS],
  "HV-HD": [DEFAULT_REFUSAL, CAN_RESOLVE, HUMAN_FRAMES, HUMAN_VERBS],
  "HV-AU": [DEFAULT_REFUSAL, CAN_RESOLVE],
  "HV-DC": [DEFAULT_REFUSAL, DECISION],
  "ANS-OT": [RULE_REFUSAL],
  "ANS-OR": [RULE_REFUSAL],
  "ANS-CO": [RULE_REFUSAL, CAN_RESOLVE],
  "ANS-WK": [RULE_REFUSAL, CAN_RESOLVE],
  "ANS-HD": [RULE_REFUSAL, CAN_RESOLVE],
  "ANS-AU": [RULE_REFUSAL, CAN_RESOLVE],
  "ANS-DC": [...DECIDER, RULE_REFUSAL],
  "ANS-DC-QA": [RULE_REFUSAL, DECIDABLE, CONDITIONS],
};
