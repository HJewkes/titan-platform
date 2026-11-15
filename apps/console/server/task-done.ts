import { z } from "zod";
import { EXIT, defineCommand } from "@titan-design/registry";
import { failure, type ActiveWork } from "./active-work.js";
import type { ConsoleContext } from "./owner-guard.js";

const taskDoneArgs = z.object({ slug: z.string().min(1), id: z.string().min(1), undo: z.boolean().optional() });

const taskDoneResult = z.object({ id: z.string(), status: z.enum(["open", "done", "wont-do", "icebox"]) });

type TaskDoneArgs = z.infer<typeof taskDoneArgs>;

/** Done goes through `task.done`; undo reopens through `task.edit` on status, as the dashboard's undo toast does. */
async function writeTaskDone(activeWork: ActiveWork, { slug, id, undo }: TaskDoneArgs): Promise<z.infer<typeof taskDoneResult>> {
  if (activeWork.write === undefined) throw failure("This active-work source takes no writes", EXIT.UNAVAILABLE);
  const written = undo === true ? await activeWork.write("task.edit", { slug, id, field: "status", value: "open" }) : await activeWork.write("task.done", { slug, id });
  return { id: written.id, status: written.status };
}

/** `work.task-done` without its class; `commands.ts` registers it as the owner-write it is. */
export function taskDoneCommand(activeWork: ActiveWork) {
  return defineCommand<TaskDoneArgs, z.infer<typeof taskDoneResult>, ConsoleContext>({
    name: "work.task-done",
    description: "Mark one task done, or with undo reopen it, through active-work's task.done and task.edit",
    args: taskDoneArgs,
    result: taskDoneResult,
    run: (args) => writeTaskDone(activeWork, args),
  });
}
