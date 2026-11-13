/** A synthetic initiative as active-work's `list` reports it. */
export interface FakeInitiative {
  slug: string;
  task_prefix: string;
  agent_visible?: boolean;
}

interface FakeTaskRow {
  id: string;
  slug: string;
}

/** The demo task most register tests deliver. */
const DEMO_TASKS: readonly FakeTaskRow[] = [{ id: "T-1", slug: "demo" }];

/** Each slug's prefix is its first task's: enough for a fixture where no id is shared. */
const initiativesOf = (tasks: readonly FakeTaskRow[]): FakeInitiative[] =>
  [...new Map(tasks.map((task) => [task.slug, task.id.slice(0, task.id.lastIndexOf("-"))])).entries()].map(([slug, prefix]) => ({ slug, task_prefix: prefix }));

/** The answer to `list` for `initiatives`: one section, every initiative agent-visible unless it says otherwise. */
export function listAnswer(initiatives: readonly FakeInitiative[]) {
  return { sections: [{ heading: "Focused", items: initiatives.map((item) => ({ ...item, agent_visible: item.agent_visible ?? true })) }] };
}

/** An active-work daemon over `fetch` that answers only the task index: `task.list` with `tasks`, and `list` with `initiatives`. */
export function taskIndexFetch(tasks: readonly FakeTaskRow[] = DEMO_TASKS, initiatives: readonly FakeInitiative[] = initiativesOf(tasks)): typeof fetch {
  return async (url) => {
    const command = String(url).split("/rpc/")[1];
    const data = command === "task.list" ? { tasks } : command === "list" ? listAnswer(initiatives) : undefined;
    return new Response(JSON.stringify(data === undefined ? { ok: false, error: `the fake has no ${command}` } : { ok: true, data }));
  };
}
