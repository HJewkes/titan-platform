import { redact } from "./redact.js";
import type { Rest } from "./rest.js";

interface GhGraphql<T> {
  data?: T;
  errors?: { message: string }[];
}

/** GraphQL answers 200 with `errors` and no data on a failed query, so a missing value is the failure. */
export async function graphql<T, R>(api: Rest, what: string, query: string, variables: Record<string, unknown>, pick: (data: T) => R | null | undefined): Promise<R> {
  const answer = await api.send<GhGraphql<T>>("POST", "graphql", {}, JSON.stringify({ query, variables }));
  const value = answer.data === undefined ? undefined : pick(answer.data);
  if (value === null || value === undefined) throw new Error(redact(`${what} unreadable: ${answer.errors?.map((error) => error.message).join("; ") ?? "not found"}`, []));
  return value;
}
