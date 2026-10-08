import { describe, expect, it } from "vitest";
import { REF_CLASSES, initiativeForTask, refToRoute, type RefTarget } from "./refs.js";
import { href, parseRoute } from "./router.js";

describe("refToRoute", () => {
  const cases: [string, RefTarget][] = [
    ["task:OR-12", { kind: "route", route: { view: "tasks", id: "OR-12" } }],
    ["note:orbit-relay/2031-03-03-backoff-ceiling.md", { kind: "route", route: { view: "knowledge", id: "note:orbit-relay/2031-03-03-backoff-ceiling.md" } }],
    ["source:orbit-relay/captures/station-7.md", { kind: "route", route: { view: "knowledge", id: "source:orbit-relay/captures/station-7.md" } }],
    ["session:0b7e2c1a-5d4f-4e8b-9a61-3c2d1e0f9a8b", { kind: "route", route: { view: "sessions", id: "0b7e2c1a-5d4f-4e8b-9a61-3c2d1e0f9a8b" } }],
    ["agent:relay-worker-3", { kind: "route", route: { view: "agents", id: "relay-worker-3" } }],
    ["pr:example-org/orbit-relay#41", { kind: "github", url: "https://github.com/example-org/orbit-relay/pull/41" }],
    ["code:orbit-relay:src/route/table.ts", { kind: "codewatch", repo: "orbit-relay", path: "src/route/table.ts" }],
  ];

  it("covers every ref class", () => {
    expect(cases.map(([ref]) => ref.split(":")[0])).toEqual([...REF_CLASSES]);
  });

  it.each(cases)("maps %s", (ref, target) => {
    expect(refToRoute(ref)).toEqual(target);
  });

  it("gives a route that survives a trip through the hash", () => {
    const target = refToRoute("note:orbit-relay/2031-03-03-backoff-ceiling.md");
    if (target?.kind !== "route") throw new Error("expected a console route");
    expect(parseRoute(href(target.route))).toEqual(target.route);
  });

  it.each(["", "task", "task:", "ticket:OR-12", "pr:orbit-relay#41", "code:orbit-relay"])("refuses the malformed ref %j", (ref) => {
    expect(refToRoute(ref)).toBeUndefined();
  });
});

describe("a task's initiative", () => {
  const portfolio = [
    { slug: "orbit-relay", topTask: { id: "OR-12" } },
    { slug: "lantern-docs", topTask: { id: "LD-3" } },
    { slug: "atlas-archive" },
  ];

  it("comes from the id prefix of a task route", () => {
    expect(initiativeForTask(parseRoute("#/tasks/OR-9").id!, portfolio)).toBe("orbit-relay");
    expect(initiativeForTask("LD-40b", portfolio)).toBe("lantern-docs");
  });

  it("is unknown for an unmatched prefix or an id that is not a task id", () => {
    expect(initiativeForTask("AA-1", portfolio)).toBeUndefined();
    expect(initiativeForTask("orbit", portfolio)).toBeUndefined();
  });
});
