/**
 * One plain sentence for a refusal: what happened and what to do next. The factory's refusal codes (`console-action/outcome.ts`)
 * and the console's own (`too-large`, `bad-request`, `shepherd`) reach the owner through this, so a raw code never shows.
 * Retryable codes say to tap again later; the rest say to read the item again, or that the console has no path.
 */
const SENTENCES: Readonly<Record<string, string>> = {
  record: "The action record is not usable, so open the item again and retry",
  "record-unreadable": "The action record could not be read, so read the item again",
  class: "The console has no path for this kind of action, so do it on the terminal",
  evidence: "The evidence the factory needs is missing, so read the item again",
  mismatch: "The item changed since you read it, so read the item again",
  resolver: "You are not allowed to do this from the console, so use the terminal",
  payload: "Your answer is not valid for this item, so read the item again and answer once more",
  "github-unreadable": "GitHub could not be read just now, so tap again later",
  "agent-chat-unavailable": "agent-chat is not available just now, so tap again later",
  deploying: "A deploy is running, so tap again later",
  "plan-busy": "A plan is being written, so tap again later",
  "too-large": "The answer is too large, so shorten it and tap again",
  "bad-request": "The request was not understood, so read the item again and retry",
  shepherd: "Shepherd refused the request, so read the item again to see where it stands",
};

export function refusalMessageOf(reason: string, detail: string | undefined): string {
  const sentence = Object.hasOwn(SENTENCES, reason) ? SENTENCES[reason] : undefined;
  if (sentence === undefined) return `Refused (${reason})${detail === undefined ? "" : `: ${detail}`}`;
  return detail === undefined ? `${sentence}.` : `${sentence} (${detail}).`;
}
