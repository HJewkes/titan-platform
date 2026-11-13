export const FAILURE_CLASSES = ["ci-timeout", "gh-api-5xx", "gh-rate-limit", "land-rules", "update-branch", "other"] as const;
/** The closed set a failed Shepherd run is filed under, in `workflow_run.error_class`. */
export type FailureClass = (typeof FAILURE_CLASSES)[number];
