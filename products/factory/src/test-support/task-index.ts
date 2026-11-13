/** A synthetic initiative as active-work's `task.keys` reports it. */
interface FakeInitiative {
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

/** The answer to `task.keys`: each initiative with its tasks' ids, agent-visible unless it says otherwise. */
export function taskKeysAnswer(tasks: readonly FakeTaskRow[], initiatives: readonly FakeInitiative[]) {
  return { initiatives: initiatives.map((item) => ({ ...item, agent_visible: item.agent_visible ?? true, ids: tasks.filter((task) => task.slug === item.slug).map((task) => task.id) })) };
}

/** An active-work daemon over `fetch` that answers only `task.keys`. */
export function taskIndexFetch(tasks: readonly FakeTaskRow[] = DEMO_TASKS, initiatives: readonly FakeInitiative[] = initiativesOf(tasks)): typeof fetch {
  return async (url) => {
    const command = String(url).split("/rpc/")[1];
    const body = command === "task.keys" ? { ok: true, data: taskKeysAnswer(tasks, initiatives) } : { ok: false, error: `the fake has no ${command}` };
    return new Response(JSON.stringify(body));
  };
}

/** An active-work daemon from before `task.keys`: it refuses that command as the registry does and lists only open tasks. */
export function olderDaemonFetch(tasks: readonly FakeTaskRow[] = DEMO_TASKS): typeof fetch {
  return async (url) => {
    const command = String(url).split("/rpc/")[1];
    if (command === "task.list") return new Response(JSON.stringify({ ok: true, data: { tasks } }));
    return new Response(JSON.stringify({ ok: false, error: `Unknown command: ${command}`, code: 64 }), { status: 404 });
  };
}
