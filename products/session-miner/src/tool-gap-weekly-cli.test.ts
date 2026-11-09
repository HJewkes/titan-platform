import { describe, expect, it, vi } from "vitest";

type Callback = (err: Error | null, stdout: string, stderr: string) => void;

const calls = vi.hoisted(() => [] as Array<{ file: string; args: string[] }>);

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: (file: string, args: string[], callback: Callback) => {
      calls.push({ file, args });
      callback(null, "", "");
    },
  };
});

const { activeWorkCli } = await import("./tool-gap-weekly-run.js");

describe("activeWorkCli.add", () => {
  // active-work refuses a comma inside an array flag, so a joined tag list would file nothing.
  it("passes each tag as its own --tags flag", async () => {
    const action = { kind: "add" as const, patternId: "p1", title: "Gap", tags: ["tool-gap", "tool-gap:p1", "item-1"], body: "Body" };

    await activeWorkCli.add("demo", action);

    expect(calls).toEqual([
      {
        file: "active-work",
        args: ["task", "add", "demo", "--title", "Gap", "--tags", "tool-gap", "--tags", "tool-gap:p1", "--tags", "item-1", "--notes", "Body"],
      },
    ]);
  });
});
