/**
 * Flags and verbs we shipped to replace a post-filter agents kept piping after one of our CLIs.
 * Q10 `tool-adoption` reports, per entry, whether the new form took over from the old pipelines.
 */
export interface AdoptionOpportunity {
  /** A stable slug the report keys its rows by. */
  id: string;
  /** The task that shipped the new form. */
  task: string;
  /** `<owner>/<repo>#<n>` of the merged pull request. */
  pr: string;
  /** When that pull request merged, ISO UTC. */
  shipped: string;
  /** The pipelines the new form replaces: a head and Q9 patterns, normalised as `postFilters` writes them. */
  old: { head: string; patterns: readonly string[] };
  /** The head that carries the new form, and the flags of which any one marks it; none when the verb itself is new. */
  new: { head: string; flags: readonly string[] };
}

/** The opportunities tracked so far; Q9 `tool-gaps` names the patterns worth adding. */
export const ADOPTION_OPPORTUNITIES: readonly AdoptionOpportunity[] = [
  {
    id: "agent-ls-state-name",
    task: "CC-888",
    pr: "HJewkes/agent-chat#493",
    shipped: "2026-10-09T04:43:05Z",
    old: { head: "agent-chat agent ls", patterns: ["| grep -E", "| grep", "| grep -E | awk", "| grep -E | head", "| grep -E | grep -v", "| grep -i", "| grep -c"] },
    new: { head: "agent-chat agent ls", flags: ["--state", "--name"] },
  },
  {
    id: "seats-status-brief",
    task: "CC-889",
    pr: "HJewkes/agent-chat#491",
    shipped: "2026-10-09T08:06:25Z",
    old: { head: "agent-chat seats status", patterns: ["| python3 -c json", "| sed -n", "| head", "| jq -c", "| head -c", "| grep -E", "| python3 -I -c json"] },
    new: { head: "agent-chat seats status", flags: ["--brief"] },
  },
  {
    id: "shepherd-waiting",
    task: "TP-2084",
    pr: "HJewkes/titan-platform#869",
    shipped: "2026-10-09T08:28:12Z",
    old: { head: "titan-factory shepherd status", patterns: ["| python3 -c json", "| python3 -c json | head", "| python3 -I -c json", "| jq -r", "| jq -c", "| grep -E"] },
    new: { head: "titan-factory shepherd waiting", flags: [] },
  },
];
