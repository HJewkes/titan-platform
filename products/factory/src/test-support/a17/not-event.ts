/**
 * A17 cases that feed no GitHub observation, so they stay single-mode. `title` is the literal as written in `file`
 * (a describe title covers the cases under it); `reason` says why neither event-source mode applies. The structure
 * guard rejects an entry whose file no longer carries its title, and the runner reports these titles under `notEvent`.
 */
export interface NotEvent {
  readonly file: string;
  readonly title: string;
  readonly reason: string;
}

export const NOT_EVENT: readonly NotEvent[] = [
  {
    file: "deploy-ports.test.ts",
    title: "systemDeployPorts healthWithin (A17: a rate-limited probe never rolls back)",
    reason: "M0 deploy probe: asserts how a health probe answers a rate limit, with no GitHub event input",
  },
  {
    file: "deploy-watch-window.test.ts",
    title: "watchServe when reads are unavailable (A17: a rate-limited probe never rolls back)",
    reason: "M0 deploy probe: asserts the serve watch window on an unavailable read, with no GitHub event input",
  },
  {
    file: "github-api/unavailable.test.ts",
    title: "A17: an Unavailable read writes no marker and counts no re-drive",
    reason: "M1a pool contract: asserts what a rate-limited read writes to the factory database, with no GitHub event input",
  },
];
