import { execGh, GhError, type GhExec, type RepoSlug } from "@titan-design/github";
import { z } from "zod";

/** One force-push of the PR's head branch: the head it replaced, null once GitHub no longer has that commit, and the new head. */
export interface ForcePush {
  before: string | null;
  after: string | null;
}

/** The PR's force-pushes, oldest first; a list it cannot read whole throws. */
export type ReadForcePushes = (repo: RepoSlug, pr: number) => Promise<ForcePush[]>;

const GH_TIMEOUT_MS = 30_000;
const PAGE = 100;

/** REST timeline events name only the new head, so the replaced head is read from GraphQL. */
const QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      timelineItems(itemTypes: [HEAD_REF_FORCE_PUSHED_EVENT], first: ${PAGE}) {
        pageInfo { hasNextPage }
        nodes { ... on HeadRefForcePushedEvent { beforeCommit { oid } afterCommit { oid } } }
      }
    }
  }
}`;

const Commit = z.object({ oid: z.string() }).nullable();
const Timeline = z.object({
  data: z.object({
    repository: z.object({
      pullRequest: z.object({
        timelineItems: z.object({
          pageInfo: z.object({ hasNextPage: z.boolean() }),
          nodes: z.array(z.object({ beforeCommit: Commit, afterCommit: Commit })),
        }),
      }),
    }),
  }),
});

/** Named so a refusal, which carries only an error's class, says the list was cut short. */
class ForcePushesTruncated extends Error {
  override readonly name = "ForcePushesTruncated";
}

/**
 * A product-side reader until the GitHub port has a timeline read; it runs `gh` under the same login the port's wire uses.
 * More than one page of force-pushes throws rather than answer a short list.
 */
export function ghForcePushes(exec: GhExec = execGh, timeoutMs = GH_TIMEOUT_MS): ReadForcePushes {
  return async (repo, pr) => {
    const [owner, name] = repo.split("/");
    const args = ["api", "graphql", "-f", `query=${QUERY}`, "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `number=${pr}`];
    const result = await exec(args, undefined, { timeoutMs });
    if (result.code !== 0) throw new GhError(args, result);
    const items = Timeline.parse(JSON.parse(result.stdout)).data.repository.pullRequest.timelineItems;
    if (items.pageInfo.hasNextPage) throw new ForcePushesTruncated(`more than ${PAGE} force-pushes`);
    return items.nodes.map((node) => ({ before: node.beforeCommit?.oid ?? null, after: node.afterCommit?.oid ?? null }));
  };
}

/**
 * The heads force-pushes removed after the branch held `fromHead`. A push that removed `fromHead` counts, one that brought it
 * does not; with `fromHead` in no push every removed head counts, as after a rebase.
 */
export function pushedAwaySince(pushes: readonly ForcePush[], fromHead: string): (string | null)[] {
  let start = 0;
  pushes.forEach((push, index) => {
    if (push.after === fromHead) start = index + 1;
    else if (push.before === fromHead) start = index;
  });
  return pushes.slice(start).map((push) => push.before);
}
