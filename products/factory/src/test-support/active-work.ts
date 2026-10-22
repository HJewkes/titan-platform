/** A task as active-work stores it, with the fields `task.edit`'s guards read. */
export interface FakeTask {
  id: string;
  status: string;
  done_when: string;
  notes: string;
  tags: string[];
  done_at?: string;
}

export interface FakeActiveWork {
  fetch: typeof fetch;
  tasks: Map<string, FakeTask>;
  /** Every rpc call in order, with its body. */
  calls: { command: string; body: Record<string, unknown> }[];
}

/** Carries active-work's sysexits code: USAGE for a guarded edit, NOINPUT for a missing task. */
class Refused extends Error {
  constructor(message: string, readonly code = 64) {
    super(message);
  }
}

/** The fix task `sh-file-fix-task` files for a red main, as active-work holds it. */
export function filedFixTask(id: string): FakeTask {
  return { id, status: "open", done_when: "Main CI on octo/widget is green at a commit after the red sha.", notes: "Filed by Shepherd for a red main.", tags: ["main-red"] };
}

/** Mirrors active-work's `guardFieldEdit` (src/commands/task-edit.ts): the field form may not shrink notes, drop tags or replace a non-empty done_when without `force`. */
function guardFieldEdit(task: FakeTask, field: string, value: unknown): void {
  if (field === "notes" && typeof value === "string" && value.length < task.notes.length) throw new Refused(`Refusing to shrink notes (${task.notes.length} -> ${value.length} chars)`);
  if (field === "tags" && Array.isArray(value) && task.tags.some((tag) => !value.includes(tag))) throw new Refused("Refusing to drop existing tags");
  if (field === "done_when" && task.done_when.trim() !== "") throw new Refused("Refusing to replace a non-empty done_when. Pass --force to replace it");
}

function edit(task: FakeTask, body: Record<string, unknown>): FakeTask {
  if (typeof body.add_tag === "string") return task.tags.includes(body.add_tag) ? task : { ...task, tags: [...task.tags, body.add_tag] };
  if (typeof body.append === "string") return { ...task, notes: task.notes === "" ? body.append : `${task.notes}\n${body.append}` };
  const field = String(body.field);
  if (body.force !== true) guardFieldEdit(task, field, body.value);
  return { ...task, [field]: body.value, ...(field === "status" && body.value === "done" ? { done_at: "2026-10-22" } : {}) };
}

function answer(fake: FakeActiveWork, command: string, body: Record<string, unknown>): unknown {
  if (command === "task.list") return { tasks: [...fake.tasks.values()].filter((task) => body.tag === undefined || task.tags.includes(String(body.tag))) };
  const task = fake.tasks.get(String(body.id));
  if (task === undefined) throw new Refused(`Task not found: ${String(body.id)}`, 66);
  if (command !== "task.edit") throw new Refused(`the fake has no ${command}`);
  const edited = edit(task, body);
  fake.tasks.set(task.id, edited);
  return edited;
}

/** An active-work daemon over `fetch` that holds `tasks` and refuses what the real one refuses, with its usage exit code. */
export function fakeActiveWork(tasks: readonly FakeTask[]): FakeActiveWork {
  const fake: FakeActiveWork = { tasks: new Map(tasks.map((task) => [task.id, { ...task }])), calls: [], fetch: async () => new Response() };
  fake.fetch = async (url, init) => {
    const command = String(url).split("/rpc/")[1]!;
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    fake.calls.push({ command, body });
    try {
      return new Response(JSON.stringify({ ok: true, data: answer(fake, command, body) }));
    } catch (error) {
      if (!(error instanceof Refused)) throw error;
      return new Response(JSON.stringify({ ok: false, error: error.message, code: error.code }), { status: 400 });
    }
  };
  return fake;
}
