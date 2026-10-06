import { graphql } from "./graphql.js";
import type { Rest } from "./rest.js";

/** One force-push of a PR's head branch: the head it replaced, null once GitHub no longer has that commit, and the new head. */
export interface ForcePush {
  before: string | null;
  after: string | null;
}

/** What the wire read: the first `FORCE_PUSHES_CAP` pushes, oldest first, and whether more exist past them. */
export interface ForcePushPage {
  pushes: ForcePush[];
  more: boolean;
}

/** One GraphQL page; the port reads no further. */
export const FORCE_PUSHES_CAP = 100;

/** Named so a caller that reports only an error's class still says the list was cut short. */
export class ForcePushesTruncated extends Error {
  constructor() {
    super(`the PR has more than ${FORCE_PUSHES_CAP} force-pushes; do not decide from a partial list`);
    this.name = "ForcePushesTruncated";
  }
}

/** A list past the cap throws rather than answer short. */
export function wholeForcePushes(page: ForcePushPage): ForcePush[] {
  if (page.more) throw new ForcePushesTruncated();
  return page.pushes;
}

/** REST timeline events name only the new head, so the replaced head is read from GraphQL. */
const QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      timelineItems(itemTypes: [HEAD_REF_FORCE_PUSHED_EVENT], first: ${FORCE_PUSHES_CAP}) {
        pageInfo { hasNextPage }
        nodes { ... on HeadRefForcePushedEvent { beforeCommit { oid } afterCommit { oid } } }
      }
    }
  }
}`;

interface GhTimeline {
  pageInfo: { hasNextPage: boolean };
  nodes: { beforeCommit: { oid: string } | null; afterCommit: { oid: string } | null }[];
}

type TimelineData = { repository?: { pullRequest?: { timelineItems?: GhTimeline } | null } | null };

export async function listForcePushes(api: Rest, repo: string, number: number): Promise<ForcePushPage> {
  const [owner, name] = repo.split("/");
  const items = await graphql(api, `force-pushes of ${repo}#${number}`, QUERY, { owner, name, number }, (data: TimelineData) => data.repository?.pullRequest?.timelineItems);
  return { pushes: items.nodes.map((node) => ({ before: node.beforeCommit?.oid ?? null, after: node.afterCommit?.oid ?? null })), more: items.pageInfo.hasNextPage };
}
