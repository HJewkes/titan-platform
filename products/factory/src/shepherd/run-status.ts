/** Shepherd's finished run statuses; unlike host.ts SETTLED it leaves out recovery_required, which a Shepherd run can still leave. */
export const FINISHED_RUN_STATUSES: ReadonlySet<string> = new Set(["completed", "failed", "cancelled"]);
