/** Where a fix task goes when the merged PR's registration names no `<initiative>/<id>` task. */
export const DEFAULT_FIX_INITIATIVE = "titan-platform";

/** `<initiative>/<id>` of the merged PR's registration; anything else files into the default initiative. */
export function initiativeOf(task: string | undefined): string | undefined {
  const initiative = task?.split("/")[0];
  return task !== undefined && task.includes("/") && /^[a-z0-9][a-z0-9-]*$/i.test(initiative ?? "") ? initiative : undefined;
}
