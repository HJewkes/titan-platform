import { describe, expect, it } from "vitest";
import { parseTaskList } from "./active-work-tasks.js";

const GOOD = { id: "SI-1", title: "First", status: "open" };

describe("parseTaskList", () => {
  it("reads the --json envelope", () => {
    const text = JSON.stringify({ ok: true, data: { tasks: [GOOD] } });

    expect(parseTaskList(text).map((t) => t.id)).toEqual(["SI-1"]);
  });

  it("reads a bare tasks object", () => {
    const text = JSON.stringify({ tasks: [GOOD] });

    expect(parseTaskList(text).map((t) => t.id)).toEqual(["SI-1"]);
  });

  it("drops a malformed task and keeps the rest", () => {
    const text = JSON.stringify({ tasks: [{ id: "SI-2" }, GOOD] });

    expect(parseTaskList(text).map((t) => t.id)).toEqual(["SI-1"]);
  });
});
