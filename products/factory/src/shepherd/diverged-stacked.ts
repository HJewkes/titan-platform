import type { PullRequest, RepoSlug } from "@titan-design/github";
import { errorClass } from "./error-class.js";
import type { ShepherdServices } from "./services.js";
import { stackChildren } from "./stack-land.js";

/**
 * The open PRs still based on a merged parent's branch, which its abandoned run's sh-stack-children never restacked
 * or retargeted: `stacked` names them, `stackedUnread` why they could not be listed. Empty when there are none.
 */
export interface StackedLeft {
  stacked?: number[];
  stackedUnread?: string;
}

/** A diverged run's abandon drops its post-merge tail, so the sweep lists the children that tail would have moved. */
export async function stackedLeft(services: ShepherdServices, repo: RepoSlug, parent: PullRequest): Promise<StackedLeft> {
  try {
    const children = await stackChildren(services, { repo, parentPr: parent.number, parentHeadRef: parent.headRef, parentHeadRepo: parent.headRepo });
    return children.length > 0 ? { stacked: children.map((child) => child.pr) } : {};
  } catch (error) {
    return { stackedUnread: errorClass(error) };
  }
}

export const hasStackedLeft = (left: StackedLeft): boolean => left.stacked !== undefined || left.stackedUnread !== undefined;
