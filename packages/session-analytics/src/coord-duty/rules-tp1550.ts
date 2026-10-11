import type { DutyRuleSet } from "./rules.js";

const SPAWN_OR_RESUME = /agent-chat agent (spawn|resume)/;
const SENDS = ["*chat_send", "*chat_broadcast", "*chat_notify"];
const WRITES = ["Write", "Edit"];

/** The 2026-10-04 TP-1550 rules, copied from duty2.py in order. Kept as the baseline the v3 rules are compared against. */
export const TP1550_RULES: DutyRuleSet = {
  id: "tp1550",
  bash: [
    { id: "merge", pattern: /seat-merge |gh pr merge|update-branch|\/bin\/merge/, duty: "merge" },
    {
      id: "pacing",
      pattern: /bin\/pace|session_budget|vm\.loadavg|memory_pressure|uptime|ps -Ao|kern\.memorystatus|pool-readings|score\.py|kalloc/,
      unless: SPAWN_OR_RESUME,
      duty: "pacing",
    },
    { id: "seats-status", pattern: /agent-chat seats (status)/, duty: "pacing" },
    {
      id: "ci-watch",
      pattern: /ci-wait|gh run |gh pr checks|actions\/runs|statusCheckRollup|sleep \d+;? *(gh|H=|s=)|for i in \$\(seq 1 \d+\); do s=\$\(gh pr view/,
      duty: "ci-watch",
    },
    { id: "timed-hold", pattern: /until \[|sleep \d+\s*(;|$)|stagger/, duty: "timed-hold" },
    { id: "dispatch", pattern: SPAWN_OR_RESUME, duty: "dispatch-brief" },
    {
      id: "triage-close",
      pattern: /agent-chat agent (retire|park)|worktree remove|refs\/heads|git -C \S+ status|--status done|status --porcelain/,
      duty: "triage-close",
    },
    { id: "handoff", pattern: /agent-chat seats boot|charter\.md|seats\/\S+\.md/, duty: "handoff" },
    { id: "log-bookkeep", pattern: /logs\/[a-z-]+(\/|")|dispatch\.jsonl|bin\/log/, also: />>|printf|echo/, duty: "log-bookkeep" },
    { id: "task-bookkeep", pattern: /active-work task (add|edit|done|delete)|tasks\/\S*\.yml.*(sed -i|>>)|queues\//, duty: "task-bookkeep" },
    { id: "brief", pattern: /scratchpad\/(impl|plan|brief|b-|fix|review|r-)|\.plans\/|briefs\//, duty: "dispatch-brief" },
    { id: "triage-read", pattern: /gh pr (view|diff)|gh api repos\/\S+\/pulls|tool-results|\.jsonl|agent ls|events\.db/, duty: "triage-read" },
    { id: "dispatch-select", pattern: /active-work task (list|show)|tasks\/|tasks"|queue/, duty: "dispatch-select" },
    { id: "scope-verify", pattern: /git (show|grep|log|ls-tree|fetch|diff)/, duty: "scope-verify" },
    { id: "seat-own-work", pattern: /sources\/(audits|research|factory)|eval-corpus|design-sitting|artifacts/, duty: "seat-own-work" },
  ],
  tools: [
    { id: "spawn-review", tools: ["*agent_spawn"], when: { field: "name", pattern: /review/ }, duty: "review-route" },
    { id: "spawn", tools: ["*agent_spawn"], duty: "dispatch-brief" },
    { id: "resume-review", tools: ["*agent_resume"], when: { field: "name", pattern: /review/ }, duty: "review-route" },
    { id: "resume-fix", tools: ["*agent_resume"], when: { field: "message", pattern: /fix round|FIX_FIRST|re-review/i }, duty: "review-route" },
    { id: "resume", tools: ["*agent_resume"], duty: "dispatch-brief" },
    { id: "handoff", tools: ["*agent_teleport", "*chat_register", "ToolSearch", "CronCreate", "CronDelete", "CronList"], duty: "handoff" },
    { id: "budget", tools: ["*session_budget"], duty: "pacing" },
    { id: "monitor", tools: ["Monitor"], duty: "ci-watch" },
    { id: "send-owner", tools: SENDS, when: { field: "to", recipient: "owner" }, duty: "owner-comm" },
    { id: "send-peer", tools: SENDS, when: { field: "to", pattern: /-coord$/ }, duty: "peer-coord" },
    { id: "send-review", tools: SENDS, when: { field: "to", pattern: /review/ }, duty: "review-route" },
    { id: "send-agent", tools: SENDS, duty: "dispatch-brief" },
    { id: "push", tools: ["PushNotification"], duty: "owner-comm" },
    { id: "claim", tools: ["*chat_claim", "*chat_release"], duty: "peer-coord" },
    { id: "inbox", tools: ["*chat_inbox", "*agent_list", "*agent_logs", "*chat_transcript"], duty: "triage-read" },
    { id: "write-task", tools: WRITES, when: { field: "file_path", pattern: /\/tasks\/|\/queues\// }, duty: "task-bookkeep" },
    { id: "write-log", tools: WRITES, when: { field: "file_path", pattern: /\/logs\// }, duty: "log-bookkeep" },
    { id: "write-brief", tools: WRITES, when: { field: "file_path", pattern: /scratchpad|\/briefs\/|\.plans/ }, duty: "dispatch-brief" },
    { id: "write-owner", tools: WRITES, when: { field: "file_path", pattern: /sitting|morning|digest/ }, duty: "owner-comm" },
    { id: "write", tools: WRITES, duty: "seat-own-work" },
    { id: "read-handoff", tools: ["Read"], when: { field: "file_path", pattern: /charter|\/seats\// }, duty: "handoff" },
    { id: "read-triage", tools: ["Read"], when: { field: "file_path", pattern: /tool-results|\.jsonl/ }, duty: "triage-read" },
    { id: "read-select", tools: ["Read"], when: { field: "file_path", pattern: /\/tasks\/|\/queues\// }, duty: "dispatch-select" },
    { id: "read", tools: ["Read"], duty: null },
  ],
  // duty2.py's defaults have no local-cmd entry, so such a turn falls to `other` there and here.
  triggerDefaults: {
    boot: "handoff",
    "cron-heartbeat": "dispatch-select",
    "one-shot-timer": "dispatch-select",
    "bg-task-notification": "ci-watch",
    "own-agent report": "triage-read",
    "agent-chat system msg": "triage-read",
    "peer-seat msg": "peer-coord",
    "operator/ram relay": "owner-comm",
    "owner/direct": "owner-comm",
  },
};
