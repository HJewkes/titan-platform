// Id formats shared by task.ts, planning.ts and provenance.ts. They live apart so provenance.ts can name an outcome
// id and a task id without an import cycle: planning.ts already imports task.ts.

export const SLUG = "[a-z0-9][a-z0-9-]*";

export const TASK_ID_REGEX = /^[A-Z][A-Z0-9]*-\d+$/;

/** `<initiative>/<slug>`, the id of a planning `Outcome` (for example `alpha/faster-landing`). */
export const OUTCOME_ID_REGEX = new RegExp(`^${SLUG}/${SLUG}$`);
