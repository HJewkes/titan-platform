/** A `shepherd_registration` row as SQLite returns it; columns later migrations added are optional. */
export interface RegistrationRow {
  repo: string;
  pr: number | null;
  branch: string | null;
  run_id: string;
  task: string;
  implementer: string;
  reviewer: string | null;
  policy: string;
  kind: string;
  slice: string | null;
  held: number;
  hold_reason: string | null;
  hold_reviewer?: string | null;
  release_ready_head?: string | null;
  release_ready_at?: string | null;
  hold_satisfied_head?: string | null;
  hold_satisfied_by?: string | null;
  review_request_head?: string | null;
  review_request_at?: string | null;
  review_request_taken_at?: string | null;
  head_sha?: string | null;
  base?: string | null;
  created_at: string;
  updated_at: string;
}
