/** The only conclusions an App-posted check run may carry. */
export const CHECK_CONCLUSIONS = ["success", "failure", "action_required"] as const;

export type CheckConclusion = (typeof CHECK_CONCLUSIONS)[number];

export interface CreateCheckRunRequest {
  name: string;
  headSha: string;
  /** Typed narrowly, and checked again at runtime because callers cross a JSON boundary. */
  conclusion: CheckConclusion;
  title: string;
  summary: string;
  externalId: string;
}

/** The REST body for `POST /repos/{repo}/check-runs`; a run created already completed. */
export function checkRunBody(request: CreateCheckRunRequest): string {
  return JSON.stringify({
    name: request.name,
    head_sha: request.headSha,
    status: "completed",
    conclusion: request.conclusion,
    external_id: request.externalId,
    output: { title: request.title, summary: request.summary },
  });
}
