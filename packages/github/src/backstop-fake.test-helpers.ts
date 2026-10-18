import type { GhCommit, GhContext, GhDonePr, GhOpenPr, GhReview } from "./backstop-query.js";
import { rateBudget } from "./budget.js";
import type { GhExec } from "./exec.js";
import { fakeSha } from "./fake.js";
import { fakeFetch, type FakeAnswer, type FetchCall } from "./fetch-fake.test-helpers.js";
import { octokitClient } from "./octokit-client.js";
import { octokitRest } from "./octokit-rest.js";
import { restCaller } from "./rest.js";

/** A repo as GitHub's GraphQL would page it; cursors are offsets, so a test can count pages. */
export interface FakeRepo {
  open: { number: number; head: string; updatedAt: string }[];
  done: GhDonePr[];
  /** Newest first, as `history` answers. */
  main: string[];
  contexts: Map<string, GhContext[]>;
  reviews: Map<number, GhReview[]>;
  /** Answered beside the data on every query, as GitHub does for a partly failed one. */
  errors?: { message: string }[];
}

export const emptyRepo = (): FakeRepo => ({ open: [], done: [], main: [fakeSha("tip")], contexts: new Map(), reviews: new Map() });

export const checkRun = (id: number): GhContext => ({ __typename: "CheckRun", databaseId: id, name: `check-${id}`, status: "COMPLETED", conclusion: "SUCCESS", completedAt: "2026-01-01T00:00:00Z" });

export const status = (context: string): GhContext => ({ __typename: "StatusContext", context, state: "SUCCESS", createdAt: "2026-01-01T00:00:00Z" });

export const review = (id: number): GhReview => ({ databaseId: id, state: "APPROVED", submittedAt: "2026-01-01T00:00:00Z" });

export const range = (count: number, from = 1): number[] => Array.from({ length: count }, (_, i) => from + i);

interface SentQuery {
  query: string;
  variables: Record<string, unknown>;
}

/** A `Rest` over `gh api` answered by a fake GitHub serving `repo`, recording each GraphQL query it was sent. */
export function backstopApi(repo: FakeRepo) {
  const { respond, sent } = graphqlServer(repo);
  const exec: GhExec = async (_args, input) => ({ code: 0, stdout: `HTTP/2.0 200 OK\ncontent-type: application/json\n\n${JSON.stringify(respond(input!))}`, stderr: "" });
  return { api: restCaller(exec, rateBudget(), 10), sent };
}

/** The same fake behind Octokit's `fetch`, whose throttle spaces GraphQL posts, so only short reads use it. */
export function backstopOctokitApi(repo: FakeRepo) {
  const { respond, sent } = graphqlServer(repo);
  const fake = fakeFetch((call: FetchCall): FakeAnswer => ({ status: 200, body: respond(call.body!) }));
  const client = octokitClient({ fetch: fake.fetch, token: async () => "ghp_synthetic_backstop_token_0000000000", throttleId: `backstop-${++clients}` });
  return { api: octokitRest(client, 10), sent };
}

let clients = 0;

function sentQuery(input: string): SentQuery {
  const body: unknown = JSON.parse(input);
  if (typeof body !== "object" || body === null || !("query" in body) || !("variables" in body)) throw new Error(`not a GraphQL body: ${input}`);
  const { query, variables } = body;
  if (typeof query !== "string" || typeof variables !== "object" || variables === null) throw new Error(`not a GraphQL body: ${input}`);
  return { query, variables: Object.fromEntries(Object.entries(variables)) };
}

function graphqlServer(repo: FakeRepo) {
  const sent: SentQuery[] = [];
  const respond = (input: string): object => {
    const body = sentQuery(input);
    sent.push(body);
    const rateLimit = { cost: 1, remaining: 5000 - sent.length, resetAt: "2026-01-01T01:00:00Z" };
    return { data: { rateLimit, repository: answer(repo, body.variables) }, ...(repo.errors ? { errors: repo.errors } : {}) };
  };
  return { respond, sent };
}

function answer(repo: FakeRepo, variables: Record<string, unknown>): object {
  if (typeof variables.oid === "string") return { object: { statusCheckRollup: { contexts: forward(repo.contexts.get(variables.oid) ?? [], variables.after, 100) } } };
  if (typeof variables.number === "number") return { pullRequest: { reviews: backward(repo.reviews.get(variables.number) ?? [], variables.before, 100) } };
  return {
    ...(variables.withOpen ? { open: forward(repo.open.map((pr) => openPr(repo, pr)), variables.openAfter, 50) } : {}),
    ...(variables.withDone ? { done: forward(repo.done, variables.doneAfter, 20) } : {}),
    ...(variables.withHistory ? { ref: { target: { oid: repo.main[0], history: forward(repo.main.map((oid) => commit(repo, oid)), variables.historyAfter, 50) } } } : {}),
  };
}

function openPr(repo: FakeRepo, pr: FakeRepo["open"][number]): GhOpenPr {
  const reviews = backward(repo.reviews.get(pr.number) ?? [], null, 20);
  return { number: pr.number, headRefOid: pr.head, baseRefName: "main", updatedAt: pr.updatedAt, commits: { nodes: [{ commit: commit(repo, pr.head) }] }, reviews };
}

function commit(repo: FakeRepo, oid: string): GhCommit {
  const contexts = repo.contexts.get(oid);
  return { oid, statusCheckRollup: contexts ? { contexts: forward(contexts, null, 50) } : null };
}

function forward<N>(items: N[], after: unknown, size: number) {
  const start = typeof after === "string" ? Number(after) : 0;
  const end = Math.min(items.length, start + size);
  return { pageInfo: { hasNextPage: end < items.length, endCursor: String(end) }, nodes: items.slice(start, end) };
}

function backward<N>(items: N[], before: unknown, size: number) {
  const end = typeof before === "string" ? Number(before) : items.length;
  const start = Math.max(0, end - size);
  return { pageInfo: { hasPreviousPage: start > 0, startCursor: String(start) }, nodes: items.slice(start, end) };
}
