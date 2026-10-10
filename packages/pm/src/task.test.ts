// fixtures/SI-1.yml and fixtures/SI-2.yml are copied unchanged from active-work
// __tests__/fixtures/mini-active-root/sample-initiative/tasks/ at a2892b314016a650531ccb0adffe2af5a2dd75d5.
// The cases below port active-work __tests__/schemas/task.test.ts at 4c8ed7e7f83bb04accb79a99dd32c0223fd904e1.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { TaskSchema } from "./task.js";

const readFixture = (name: string): unknown =>
  parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

const validBase = {
  id: "EC-1",
  title: "Set up schemas",
  priority: 1,
  status: "open" as const,
  created: "2026-05-12",
  updated: "2026-05-12",
  done_at: null,
};

describe("active-work task fixtures", () => {
  it.each(["SI-1.yml", "SI-2.yml"])("parses %s", (name) => {
    expect(TaskSchema.safeParse(readFixture(name)).success).toBe(true);
  });

  it("keeps every optional field of a populated task", () => {
    const task = TaskSchema.parse(readFixture("SI-1.yml"));
    expect(task).toMatchObject({ severity: "high", estimate: 3, tags: ["example"], done_at: null });
  });
});

describe("TaskSchema", () => {
  it("accepts a golden valid task", () => {
    expect(TaskSchema.safeParse(validBase).success).toBe(true);
  });

  it("accepts all optional fields populated", () => {
    const result = TaskSchema.safeParse({
      ...validBase,
      severity: "high",
      estimate: 2.5,
      done_when: "tests pass",
      tags: ["infra", "wave1"],
      notes: "remember to bump schema_version",
      done_at: "2026-05-13",
      status: "done",
    });
    expect(result.success).toBe(true);
  });

  it.each(["id", "title", "priority", "status", "created", "updated", "done_at"])(
    "rejects when required field %s is missing",
    (field) => {
      const input: Record<string, unknown> = { ...validBase };
      delete input[field];
      const result = TaskSchema.safeParse(input);
      expect(result.success).toBe(false);
      expect(result.error?.issues.some((i) => i.path[0] === field)).toBe(true);
    },
  );

  it.each(["ec-1", "EC1", "EC-", "1EC-1", "EC-abc", "eC-1"])("rejects invalid id %s", (id) => {
    const result = TaskSchema.safeParse({ ...validBase, id });
    expect(result.success).toBe(false);
    expect(result.error?.issues.some((i) => i.path[0] === "id")).toBe(true);
  });

  it("accepts uppercase prefix with digits", () => {
    expect(TaskSchema.safeParse({ ...validBase, id: "A1B2-99" }).success).toBe(true);
  });

  it("leaves an unknown status to the registry check and rejects only an empty one", () => {
    expect(TaskSchema.safeParse({ ...validBase, status: "icebox" }).success).toBe(true);
    expect(TaskSchema.safeParse({ ...validBase, status: "" }).success).toBe(false);
  });

  it("accepts kind, cos, area and due", () => {
    const result = TaskSchema.safeParse({ ...validBase, kind: "epic", cos: "fixed", area: "pm", due: "2026-11-02" });
    expect(result.success).toBe(true);
  });

  it("rejects a due that is not a calendar date", () => {
    expect(TaskSchema.safeParse({ ...validBase, due: "2026-02-30" }).success).toBe(false);
  });

  it.each(["kind", "cos", "area"])("rejects an empty %s", (field) => {
    expect(TaskSchema.safeParse({ ...validBase, [field]: "" }).success).toBe(false);
  });

  it("rejects invalid severity enum", () => {
    expect(TaskSchema.safeParse({ ...validBase, severity: "urgent" }).success).toBe(false);
  });

  it("rejects non-positive priority", () => {
    expect(TaskSchema.safeParse({ ...validBase, priority: 0 }).success).toBe(false);
    expect(TaskSchema.safeParse({ ...validBase, priority: -1 }).success).toBe(false);
  });

  it("rejects non-positive estimate", () => {
    expect(TaskSchema.safeParse({ ...validBase, estimate: 0 }).success).toBe(false);
    expect(TaskSchema.safeParse({ ...validBase, estimate: -2 }).success).toBe(false);
  });

  it('rejects non-zero-padded date "2026-5-1"', () => {
    expect(TaskSchema.safeParse({ ...validBase, created: "2026-5-1" }).success).toBe(false);
  });

  it('rejects impossible date "2026-13-01"', () => {
    expect(TaskSchema.safeParse({ ...validBase, updated: "2026-13-01" }).success).toBe(false);
  });

  it("accepts done_at as null or as a valid date", () => {
    expect(TaskSchema.safeParse({ ...validBase, done_at: null }).success).toBe(true);
    expect(TaskSchema.safeParse({ ...validBase, done_at: "2026-05-13" }).success).toBe(true);
  });

  it("rejects done_at as an invalid date string", () => {
    expect(TaskSchema.safeParse({ ...validBase, done_at: "2026-13-01" }).success).toBe(false);
  });

  it("accepts a parent id and a dep id list", () => {
    const result = TaskSchema.safeParse({ ...validBase, parent: "EC-2", dep: ["EC-3", "XY-4"] });
    expect(result.success).toBe(true);
  });

  it("rejects a parent that is not a task id", () => {
    expect(TaskSchema.safeParse({ ...validBase, parent: "some-epic" }).success).toBe(false);
  });

  it("rejects a list of parents", () => {
    expect(TaskSchema.safeParse({ ...validBase, parent: ["EC-2", "EC-3"] }).success).toBe(false);
  });

  it("rejects a dep list with a repeated id", () => {
    const result = TaskSchema.safeParse({ ...validBase, dep: ["EC-2", "EC-2"] });
    expect(result.success).toBe(false);
    expect(result.error?.issues.some((i) => i.path[0] === "dep")).toBe(true);
  });

  it("rejects a dep entry that is not a task id", () => {
    expect(TaskSchema.safeParse({ ...validBase, dep: ["ec-2"] }).success).toBe(false);
  });

  it("accepts a deliverables id list", () => {
    const result = TaskSchema.safeParse({ ...validBase, deliverables: ["console-v1", "Relay2"] });
    expect(result.data?.deliverables).toEqual(["console-v1", "Relay2"]);
  });

  it("rejects a deliverables list with a repeated id", () => {
    const result = TaskSchema.safeParse({ ...validBase, deliverables: ["console-v1", "console-v1"] });
    expect(result.error?.issues.some((i) => i.path[0] === "deliverables")).toBe(true);
  });

  it.each(["1st", "-x", "a_b", ""])("rejects deliverable id %j", (id) => {
    expect(TaskSchema.safeParse({ ...validBase, deliverables: [id] }).success).toBe(false);
  });

  it("rejects empty title", () => {
    expect(TaskSchema.safeParse({ ...validBase, title: "" }).success).toBe(false);
  });
});

describe("TaskSchema datetime-tolerant dates", () => {
  it("parses a date-only task and a datetime task", () => {
    expect(TaskSchema.safeParse(validBase).success).toBe(true);
    const datetime = {
      ...validBase,
      created: "2026-10-08T14:03:22.123Z",
      done_at: "2026-10-09T01:00:00Z",
      started_at: "2026-10-08T15:00:00Z",
    };
    expect(TaskSchema.safeParse(datetime).success).toBe(true);
  });

  it.each(["2026-10-08T25:00:00Z", "2026-02-30T10:00:00Z", "2026-10-08T10:00", "not-a-date", "2026-10-08 10:00:00Z"])(
    "rejects the malformed datetime %s",
    (value) => {
      expect(TaskSchema.safeParse({ ...validBase, created: value }).success).toBe(false);
      expect(TaskSchema.safeParse({ ...validBase, done_at: value }).success).toBe(false);
      expect(TaskSchema.safeParse({ ...validBase, started_at: value }).success).toBe(false);
    },
  );

  it("keeps started_at optional and rejects a date-only value", () => {
    expect(TaskSchema.safeParse({ ...validBase, started_at: "2026-10-08" }).success).toBe(false);
  });

  it("still requires updated to be a date", () => {
    expect(TaskSchema.safeParse({ ...validBase, updated: "2026-10-08T14:03:22Z" }).success).toBe(false);
  });
});

describe("TaskSchema actual block", () => {
  const actual = {
    agentHours: 1.5,
    reviewAgentHours: 0.25,
    usd: 12.34,
    serviceWallHours: 3,
    peakContext: 180000,
    contextAtFirstDeliverable: 120000,
    at: "2026-10-09T02:00:00Z",
    model: "a1b2c3d",
  };

  it("accepts a populated actual block", () => {
    const result = TaskSchema.safeParse({ ...validBase, actual });
    expect(result.success).toBe(true);
    expect(result.data?.actual).toEqual(actual);
  });

  it("accepts a task with no actual block", () => {
    expect(TaskSchema.parse(validBase).actual).toBeUndefined();
  });

  it.each([
    { ...actual, agentHours: -1 },
    { ...actual, usd: "12" },
    { ...actual, at: "yesterday" },
    { ...actual, peakContext: -5 },
    "nope",
  ])("rejects the malformed actual block %#", (bad) => {
    expect(TaskSchema.safeParse({ ...validBase, actual: bad }).success).toBe(false);
  });
});

describe("TaskSchema claimedHours", () => {
  it("accepts a list of claims", () => {
    const claimedHours = [{ hours: 4, by: "bd-planner", at: "2026-10-08T10:00:00Z" }];
    expect(TaskSchema.parse({ ...validBase, claimedHours }).claimedHours).toEqual(claimedHours);
  });

  it("accepts a task with no claims", () => {
    expect(TaskSchema.parse(validBase).claimedHours).toBeUndefined();
  });

  it.each([
    [{ hours: -1, by: "x", at: "2026-10-08T10:00:00Z" }],
    [{ hours: 2, by: "", at: "2026-10-08T10:00:00Z" }],
    [{ hours: 2, by: "x", at: "soon" }],
    [{ by: "x", at: "2026-10-08T10:00:00Z" }],
  ])("rejects the malformed claim %#", (claim) => {
    expect(TaskSchema.safeParse({ ...validBase, claimedHours: [claim] }).success).toBe(false);
  });
});

describe("new task fixture", () => {
  it("parses a task with datetimes, an actual block and claimed hours", () => {
    const task = TaskSchema.parse(readFixture("PM-actual.yml"));
    expect(task.actual?.agentHours).toBe(2.5);
    expect(task.claimedHours).toHaveLength(1);
    expect(task.started_at).toBe("2026-10-08T15:00:00Z");
  });
});
