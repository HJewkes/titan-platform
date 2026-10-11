// Types of the run's recorded authors, kept apart so store.ts stays under the file-size cap.

type AuthorRole = "implementer" | "successor";

/** An agent that wrote a run's code: the implementer, or a successor that took the work over from `predecessor`. */
export interface AuthorInput {
  agentId: string;
  name: string;
  role: AuthorRole;
  predecessor?: string;
}

export interface Author {
  runId: string;
  agentId: string;
  name: string;
  role: AuthorRole;
  predecessor: string | null;
  at: string;
}

export interface AuthorRow {
  run_id: string;
  agent_id: string;
  name: string;
  role: AuthorRole;
  predecessor: string | null;
  at: string;
}
