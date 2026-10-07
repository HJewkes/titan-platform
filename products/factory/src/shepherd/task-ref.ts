import { createRpcClient, liveSource } from "@titan-design/rpc-client";

type TaskIndex = { "task.list": { args: { all_initiatives: true; status: "all" }; result: { tasks: { id: string; slug: string }[] } } };

const EXPECTED_FORM = "pass --task <initiative>/<ID>";

/** `<initiative>/<ID>` as given, or a bare ID resolved through the active-work task index; no unique answer is an error that names the expected form. */
export async function qualifyTask(task: string, options: { origin: string; fetch?: typeof fetch }): Promise<string> {
  if (task.includes("/")) return task;
  const client = createRpcClient<TaskIndex>(liveSource(options));
  let tasks: { id: string; slug: string }[];
  try {
    ({ tasks } = await client.call("task.list", { all_initiatives: true, status: "all" }));
  } catch (error) {
    throw new Error(`could not resolve task ${task} to an initiative (${(error as Error).message}); ${EXPECTED_FORM}`);
  }
  const slugs = [...new Set(tasks.filter((candidate) => candidate.id === task).map((candidate) => candidate.slug))];
  if (slugs.length === 1) return `${slugs[0]}/${task}`;
  const why = slugs.length === 0 ? "is in no initiative" : `is in ${slugs.length} initiatives (${slugs.join(", ")})`;
  throw new Error(`task ${task} ${why}; ${EXPECTED_FORM}`);
}
