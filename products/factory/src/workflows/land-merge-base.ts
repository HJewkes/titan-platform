import type { WorkflowContext } from "@titan-design/workflow";

interface MergeBaseAsk {
  headSha: string;
  base: string;
  /** The gated decision's reason; absent before the decision. */
  reason?: string;
}

/**
 * Asked at an untrusted green head before its decision, then with the reason of a gated one; true merges the base into the
 * head through land's own update-branch, whose conflict stops `conflict` as any update's does. The hook records its own step.
 */
export type MergeBaseFirst = (ctx: WorkflowContext, at: MergeBaseAsk) => Promise<boolean>;

/**
 * TP-4711: asked at a green head whose base moved after its CI started; true refuses to land that green as it stands, so land
 * updates the branch as it would a strict repo's behind head, under the same bound. The hook records its own step.
 */
export type RecheckMovedBase = (ctx: WorkflowContext, at: Omit<MergeBaseAsk, "reason">) => Promise<boolean>;

/** A run that may not update the branch never merges the base on the hook's word either. */
export async function mergesBaseFirst(ctx: WorkflowContext, hook: MergeBaseFirst | undefined, update: false | undefined, at: MergeBaseAsk): Promise<boolean> {
  return update !== false && hook !== undefined && (await hook(ctx, at));
}
