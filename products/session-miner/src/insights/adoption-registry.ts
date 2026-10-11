/**
 * Flags and verbs that replace a post-filter agents kept piping after one of our CLIs, shipped or still to build.
 * Q10 `tool-adoption` reports, per entry, whether the new form took over from the old pipelines; a baseline entry
 * counts the old pipelines alone, so it has its "before" numbers on the day it ships.
 */
interface OpportunityShape {
  /** A stable slug the report keys its rows by. */
  id: string;
  /** The rank of the opportunity in `titan-platform/sources/bash-to-tool-mining-2026-10-08.md` section 1. */
  row: number;
  /** The pipelines the new form replaces: a head and Q9 patterns, normalised as `postFilters` writes them. */
  old: { head: string; patterns: readonly string[] };
  /**
   * The head that carries the new form, and the flags of which any one marks it; none when the verb itself is new.
   * A new form on the old head with no flags cannot be told apart, so it is never counted.
   */
  new: { head: string; flags: readonly string[] };
  /** What Q10 cannot see of this opportunity, when its Bash pipelines are only part of it. */
  note?: string;
}

export interface ShippedOpportunity extends OpportunityShape {
  status: "shipped";
  /** The task that shipped the new form. */
  task: string;
  /** `<owner>/<repo>#<n>` of the merged pull request. */
  pr: string;
  /** When that pull request merged, ISO UTC. */
  shipped: string;
}

export interface BaselineOpportunity extends OpportunityShape {
  status: "baseline";
  /** The task filed to build the new form, null until one is filed. */
  task: string | null;
}

export type AdoptionOpportunity = ShippedOpportunity | BaselineOpportunity;

const NOT_OUR_CLI = "titan-gh is not one of Q9's OUR_CLIS, so the new form reads 0 until it is added there.";

/** The 10-08 top 15 and the build tasks filed from them; Q9 `tool-gaps` names the patterns worth adding. */
export const ADOPTION_OPPORTUNITIES: readonly AdoptionOpportunity[] = [
  {
    id: "chat-inbox-after",
    row: 1,
    status: "shipped",
    task: "CC-886",
    pr: "HJewkes/agent-chat#490",
    shipped: "2026-10-09T08:39:27Z",
    old: { head: "sqlite3 events.db", patterns: ["| head", "| cut -c", "| tail"] },
    new: { head: "chat_inbox", flags: ["after"] },
    note: "The new form is an MCP argument and Q10 reads only Bash, so new uses stay 0; the old count is the events.db reads it replaces.",
  },
  {
    id: "basement-suite-summary",
    row: 2,
    status: "baseline",
    task: null,
    old: { head: "basement-suite", patterns: ["| tail"] },
    new: { head: "basement-suite", flags: ["--summary"] },
  },
  {
    id: "gh-write-body-stdin",
    row: 3,
    status: "shipped",
    task: "CC-887",
    pr: "HJewkes/agent-chat#487",
    shipped: "2026-10-09T08:35:41Z",
    old: { head: "gh pr create", patterns: [] },
    new: { head: "agent-chat gh-write", flags: ["--body-file"] },
    note: "The old form is a heredoc body the leak-guard denies, not a post-filter, so old uses stay 0.",
  },
  {
    id: "profiles-name",
    row: 4,
    status: "shipped",
    task: "CC-890",
    pr: "HJewkes/agent-chat#489",
    shipped: "2026-10-09T08:13:07Z",
    old: { head: "agent-chat profiles", patterns: ["| grep", "| grep -A", "| head"] },
    new: { head: "agent-chat profiles", flags: [] },
    note: "The new form is a positional name, and the agent_profiles and chat_list filters are MCP arguments, so new uses stay 0.",
  },
  {
    id: "task-show",
    row: 5,
    status: "shipped",
    task: "CC-273",
    pr: "HJewkes/active-work#221",
    shipped: "2026-10-09T04:07:06Z",
    old: { head: "active-work task list", patterns: ["| grep -A", "| grep -A | head", "| jq -r", "| python3 -c json"] },
    new: { head: "active-work task show", flags: [] },
  },
  {
    id: "agent-ls-state-name",
    row: 6,
    status: "shipped",
    task: "CC-888",
    pr: "HJewkes/agent-chat#493",
    shipped: "2026-10-09T04:43:05Z",
    old: { head: "agent-chat agent ls", patterns: ["| grep -E", "| grep", "| grep -E | awk", "| grep -E | head", "| grep -E | grep -v", "| grep -i", "| grep -c"] },
    new: { head: "agent-chat agent ls", flags: ["--state", "--name"] },
  },
  {
    id: "titan-gh-pr-status",
    row: 7,
    status: "baseline",
    task: null,
    old: { head: "gh pr view", patterns: ["| head", "| jq -r", "| python3 -c json"] },
    new: { head: "titan-gh pr-status", flags: [] },
    note: NOT_OUR_CLI,
  },
  {
    id: "task-add-quiet",
    row: 8,
    status: "shipped",
    task: "TP-2083",
    pr: "HJewkes/active-work#222",
    shipped: "2026-10-09T04:51:21Z",
    old: { head: "active-work task add", patterns: ["| grep", "| tail", "| head"] },
    new: { head: "active-work task add", flags: ["--quiet"] },
  },
  {
    id: "task-edit-quiet",
    row: 8,
    status: "shipped",
    task: "TP-2083",
    pr: "HJewkes/active-work#222",
    shipped: "2026-10-09T04:51:21Z",
    old: { head: "active-work task edit", patterns: ["| grep", "| tail", "| head"] },
    new: { head: "active-work task edit", flags: ["--quiet"] },
  },
  {
    id: "task-done-quiet",
    row: 8,
    status: "shipped",
    task: "TP-2083",
    pr: "HJewkes/active-work#222",
    shipped: "2026-10-09T04:51:21Z",
    old: { head: "active-work task done", patterns: ["| grep -E", "| tail", "| head"] },
    new: { head: "active-work task done", flags: ["--quiet"] },
  },
  {
    id: "shepherd-waiting",
    row: 9,
    status: "shipped",
    task: "TP-2084",
    pr: "HJewkes/titan-platform#869",
    shipped: "2026-10-09T08:28:12Z",
    old: { head: "titan-factory shepherd status", patterns: ["| python3 -c json", "| python3 -c json | head", "| python3 -I -c json", "| jq -r", "| jq -c", "| grep -E"] },
    new: { head: "titan-factory shepherd waiting", flags: [] },
  },
  {
    id: "shepherd-status-filters",
    row: 9,
    status: "baseline",
    task: null,
    old: { head: "titan-factory shepherd status", patterns: ["| python3 -c json", "| python3 -c json | head", "| python3 -I -c json", "| jq -r", "| jq -c", "| grep -E"] },
    new: { head: "titan-factory shepherd status", flags: ["--active", "--phase", "--branch-prefix"] },
  },
  {
    id: "shepherd-register-infer",
    row: 10,
    status: "baseline",
    task: null,
    old: { head: "titan-factory shepherd register", patterns: ["| tail"] },
    new: { head: "titan-factory shepherd register", flags: [] },
    note: "The new form drops flags rather than adding one, so only the old tail is counted.",
  },
  {
    id: "seats-status-brief",
    row: 11,
    status: "shipped",
    task: "CC-889",
    pr: "HJewkes/agent-chat#491",
    shipped: "2026-10-09T08:06:25Z",
    old: { head: "agent-chat seats status", patterns: ["| python3 -c json", "| sed -n", "| head", "| jq -c", "| head -c", "| grep -E", "| python3 -I -c json"] },
    new: { head: "agent-chat seats status", flags: ["--brief"] },
  },
  {
    id: "agent-budget-accounts",
    row: 12,
    status: "shipped",
    task: "CC-891",
    pr: "HJewkes/agent-chat#492",
    shipped: "2026-10-09T04:50:02Z",
    old: { head: "agent-chat agent budget", patterns: ["| grep", "| head"] },
    new: { head: "agent-chat agent budget", flags: ["--accounts"] },
  },
  {
    id: "agent-retire-many",
    row: 13,
    status: "shipped",
    task: "CC-888",
    pr: "HJewkes/agent-chat#493",
    shipped: "2026-10-09T04:43:05Z",
    old: { head: "agent-chat agent retire", patterns: ["| tail", "| head"] },
    new: { head: "agent-chat agent retire", flags: [] },
    note: "The new form passes several names, which no flag marks, so only the old tail is counted.",
  },
  {
    id: "ci-failures-digest",
    row: 14,
    status: "baseline",
    task: null,
    old: { head: "gh run view", patterns: ["| grep -E", "| sed | grep -E", "| grep"] },
    new: { head: "titan-gh ci-failures", flags: [] },
    note: NOT_OUR_CLI,
  },
  {
    id: "shepherd-timeline-last",
    row: 15,
    status: "baseline",
    task: null,
    old: { head: "titan-factory shepherd timeline", patterns: ["| tail", "| tail | cut -c"] },
    new: { head: "titan-factory shepherd timeline", flags: ["--last"] },
  },
];
