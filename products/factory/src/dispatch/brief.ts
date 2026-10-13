/** Where a task's plan lives in its initiative: the planner writes it and seeding reads its slices from it. */
export const planPathFor = (initiativeDir: string, taskId: string): string => `${initiativeDir}/sources/${taskId}-plan.md`;
