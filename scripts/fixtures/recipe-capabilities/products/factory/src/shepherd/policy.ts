export async function settle(ctx: WorkflowContext, items: string[]): Promise<void> {
  for (const item of items) await ctx.dispatch(item);
}
