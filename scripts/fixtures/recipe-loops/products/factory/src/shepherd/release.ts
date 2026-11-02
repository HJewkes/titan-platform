export async function settle(ctx: WorkflowContext, items: string[]): Promise<void> {
  for (const item of items) {
    // eslint-disable-next-line titan/recipe-step-in-loop
    await ctx.dispatch(item);
  }
}
