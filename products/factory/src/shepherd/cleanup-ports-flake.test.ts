import { describe, expect, it } from "vitest";
import { fakeActiveWork, filedFixTask } from "../test-support/active-work.js";
import { activeWorkFixTasks } from "./cleanup-ports.js";
import { FixTaskRefused, type FlakeFields } from "./main-red.js";

const ORIGIN = "http://127.0.0.1:7400";

describe("the active-work flake port", () => {
  const flake: FlakeFields = { done_when: "root cause fixed", notes: "Flake (episode 1)", tag: "flake" };

  it("replaces the filed done_when with force, tags and reopens a done task, and appends the notes last, never closing it", async () => {
    const aw = fakeActiveWork([{ ...filedFixTask("FX-1"), status: "done" }]);

    await activeWorkFixTasks({ origin: ORIGIN, fetch: aw.fetch }).markFlake!("demo", "FX-1", flake);

    expect(aw.calls.slice(1).map((call) => call.body)).toEqual([
      { slug: "demo", id: "FX-1", field: "done_when", value: "root cause fixed", force: true },
      { slug: "demo", id: "FX-1", add_tag: "flake" },
      { slug: "demo", id: "FX-1", field: "status", value: "open" },
      { slug: "demo", id: "FX-1", field: "notes", value: "Filed by Shepherd for a red main.\n\nFlake (episode 1)" },
    ]);
  });

  it("writes nothing on a retry once every write landed", async () => {
    const aw = fakeActiveWork([filedFixTask("FX-1")]);
    const tasks = activeWorkFixTasks({ origin: ORIGIN, fetch: aw.fetch });
    await tasks.markFlake!("demo", "FX-1", flake);

    await tasks.markFlake!("demo", "FX-1", flake);

    expect(aw.calls.filter((call) => call.command === "task.edit")).toHaveLength(3);
  });

  it("is refused, as active-work refuses it, when a non-empty done_when is replaced without force", async () => {
    const aw = fakeActiveWork([filedFixTask("FX-1")]);

    const response = await aw.fetch(`${ORIGIN}/rpc/task.edit`, { method: "POST", body: JSON.stringify({ slug: "demo", id: "FX-1", field: "done_when", value: "other" }) });

    expect(await response.json()).toEqual({ ok: false, error: "Refusing to replace a non-empty done_when. Pass --force to replace it", code: 64 });
  });

  it("names a refusal as final, so a caller does not wait it out as an outage", async () => {
    const tasks = activeWorkFixTasks({ origin: ORIGIN, fetch: fakeActiveWork([]).fetch });

    await expect(tasks.add("demo", { title: "t", severity: "high", done_when: "d", tags: [], notes: "n" })).rejects.toBeInstanceOf(FixTaskRefused);
  });

  it("leaves an unreachable daemon an outage, which a caller waits out", async () => {
    const tasks = activeWorkFixTasks({ origin: ORIGIN, fetch: async () => Promise.reject(new Error("connect ECONNREFUSED")) });

    await expect(tasks.markFlake!("demo", "FX-1", flake)).rejects.not.toBeInstanceOf(FixTaskRefused);
  });
});
