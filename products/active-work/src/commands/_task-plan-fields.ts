import { z } from 'zod';
import { ValidationError } from '../errors.js';
import { TaskSchema, type Task } from '../schemas/task.js';

/** The P2 plan fields as `task add` and `task edit` arguments; bet and fold are checked for shape at parse. */
export const TaskPlanArgsShape = {
  bet: TaskSchema.shape.bet,
  fold: TaskSchema.shape.fold,
  owner_step: z.array(z.string().min(1)).optional(),
};

export const TASK_PLAN_OPTIONS = {
  bet: { long: '--bet', description: 'Bet id this task serves (alpha/B1); the bet must exist in the plan' },
  fold: { long: '--fold', description: 'Fold id it must land with (alpha/FD1), or independent' },
  owner_step: {
    long: '--owner-step',
    description: 'Step only the owner can take, as <kind>:<note> (kind release|restart|credential|sitting|config|publish). Repeat the flag for each value',
  },
};

type OwnerSteps = NonNullable<Task['owner_steps']>;

/** Parses each `<kind>:<note>` into an owner step, refusing a kind or note the task schema would not accept. */
export function parseOwnerSteps(raw: readonly string[] | undefined): OwnerSteps | undefined {
  if (raw === undefined) return undefined;
  const steps = raw.map((value) => {
    const cut = value.indexOf(':');
    return cut < 0 ? { kind: value, note: '' } : { kind: value.slice(0, cut), note: value.slice(cut + 1).trim() };
  });
  const parsed = TaskSchema.shape.owner_steps.safeParse(steps);
  if (!parsed.success) {
    throw new ValidationError(`--owner-step must be <kind>:<note>: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
  }
  return parsed.data;
}
