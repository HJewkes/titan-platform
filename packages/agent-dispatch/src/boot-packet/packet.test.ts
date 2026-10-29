import { describe, expect, it } from "vitest";

import { BOOT_PACKET_BUDGET, bootPacket, estimateTokens, type BootPacketInput } from "./packet.js";
import type { BootReaders, GitState, TaskCard } from "./sections.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

const PLAN = [
  "# Widget plan",
  "",
  "## Slices",
  "",
  "| id | slice |",
  "|---|---|",
  "| **W1** | Parse widgets in `packages/widget/src/parse.ts:20` and `packages/widget/src/model.ts`. |",
  "| **W2** | Render widgets. |",
  "",
  "## Tests",
  "",
  "- **W1:** a fixture widget parses. Mutation caught: dropping the last field.",
  "- **W2:** renders.",
].join("\n");

function sourceFile(name: string, lineCount: number): string {
  return Array.from({ length: lineCount }, (_, i) => `export const ${name}${i} = ${i}; // a widget source line, long enough to look like real code in a module ${"=".repeat(30)}`).join("\n");
}

const FILES: Record<string, string> = {
  "plans/widget.md": PLAN,
  "packages/widget/src/parse.ts": sourceFile("parse", 60),
  "packages/widget/src/model.ts": sourceFile("model", 40),
  "package.json": JSON.stringify({ scripts: { build: "x", test: "y", "verify:changed": "z" } }),
  "pnpm-lock.yaml": "lockfileVersion: 9",
  "CAPABILITIES.md": "| unit | tier |\n|---|---|\n| [`widget`](#cap-widget) | 1 | You need widgets. |\n",
};

const GIT: GitState = {
  capturedAt: "2030-01-02T03:04:05.000Z",
  baseRef: "origin/main",
  baseSha: SHA_A,
  headSha: SHA_B,
  ahead: [],
  landed: ["1234567 Parse the widget header (WG-7)"],
  openPrs: [],
};

const TASK: TaskCard = {
  id: "WG-8",
  title: "Parse widgets",
  status: "active",
  estimate: 3,
  doneWhen: ["a widget file parses into the model"],
  notes: ["the header parser already landed"],
};

function readers(files: Record<string, string> = FILES): BootReaders {
  return {
    readFile: (path) => files[path] ?? null,
    exists: (path) => path in files || path === "node_modules",
    gitState: () => GIT,
    readTask: (id) => (id === TASK.id ? TASK : null),
  };
}

function input(overrides: Partial<BootPacketInput> = {}): BootPacketInput {
  return {
    task: { id: "WG-8" },
    plan: { path: "plans/widget.md", slice: "W1" },
    repo: {},
    readers: readers(),
    ...overrides,
  };
}

describe("bootPacket", () => {
  it("gives every section for a task with a plan and a repo, within the budget", () => {
    const packet = bootPacket(input());

    expect(packet.sections.map((s) => s.id)).toEqual(["git", "task", "plan", "touchPoints", "readiness"]);
    expect(packet.omitted).toEqual([]);
    expect(packet.tokens).toBeLessThanOrEqual(BOOT_PACKET_BUDGET);
    expect(packet.text).toContain("WG-8: Parse widgets");
    expect(packet.text).toContain("### packages/widget/src/parse.ts:5");
    expect(packet.text).toContain("export const parse34 ");
    expect(packet.text).not.toContain("export const parse35 ");
    expect(packet.text).toContain("Install: pnpm install --frozen-lockfile");
    expect(packet.text).toContain("| [`widget`](#cap-widget)");
  });

  it("keeps only the slice's rows and bullets in the plan section", () => {
    const plan = bootPacket(input()).sections.find((s) => s.id === "plan")?.text ?? "";

    expect(plan).toContain("Mutation caught: dropping the last field.");
    expect(plan).not.toContain("Render widgets");
  });

  it("labels the git state with when it was captured", () => {
    const git = bootPacket(input()).sections[0];

    expect(git?.title).toContain("captured 2030-01-02T03:04:05.000Z");
    expect(git?.text).toContain(`HEAD: ${SHA_B}`);
    expect(git?.text).toContain("(WG-7)");
  });

  it("counts tokens, not characters, so a packet longer than the budget in characters keeps every section", () => {
    const packet = bootPacket(input());

    expect(packet.text.length).toBeGreaterThan(BOOT_PACKET_BUDGET);
    expect(packet.sections.every((s) => !s.truncated)).toBe(true);
    expect(estimateTokens("x".repeat(400))).toBe(100);
  });

  it("drops whole sections from the lowest priority up when the budget is tight", () => {
    const full = bootPacket(input());
    const sized = (ids: string[]): number => full.sections.filter((s) => ids.includes(s.id)).reduce((n, s) => n + s.tokens, 0);
    const budget = sized(["git", "task", "plan"]) + 20;

    const packet = bootPacket(input({ options: { budget } }));

    expect(packet.sections.map((s) => s.id)).toEqual(["git", "task", "plan"]);
    expect(packet.omitted).toEqual([
      { id: "touchPoints", reason: "dropped to fit the budget" },
      { id: "readiness", reason: "dropped to fit the budget" },
    ]);
    expect(packet.tokens).toBeLessThanOrEqual(budget);
  });

  it("follows a caller's priority when choosing what to drop", () => {
    const full = bootPacket(input());
    const sized = (ids: string[]): number => full.sections.filter((s) => ids.includes(s.id)).reduce((n, s) => n + s.tokens, 0);

    const packet = bootPacket(
      input({ options: { budget: sized(["touchPoints", "git"]) + 20, priority: ["touchPoints", "git", "task"] } }),
    );

    expect(packet.sections.map((s) => s.id)).toEqual(["touchPoints", "git"]);
    expect(packet.omitted).toEqual([{ id: "task", reason: "dropped to fit the budget" }]);
  });

  it("cuts a section over its cap by whole excerpts and keeps each fence closed", () => {
    const packet = bootPacket(input({ options: { caps: { touchPoints: 1400 } } }));
    const touch = packet.sections.find((s) => s.id === "touchPoints");

    expect(touch?.truncated).toBe(true);
    expect(touch?.tokens).toBeLessThanOrEqual(1400);
    expect(touch?.text).toContain("parse.ts");
    expect(touch?.text).not.toContain("model.ts");
    expect(touch?.text).toContain("[truncated to fit 1400 tokens]");
    expect((touch?.text.match(/^```/gm) ?? []).length % 2).toBe(0);
  });

  it("builds the packet without the plan section when the plan file is missing", () => {
    const packet = bootPacket(input({ plan: { path: "plans/gone.md", slice: "W1" } }));

    expect(packet.sections.map((s) => s.id)).toEqual(["git", "task", "readiness"]);
    expect(packet.omitted).toContainEqual({ id: "plan", reason: "no plan file or no slice in it" });
    expect(packet.omitted).toContainEqual({ id: "touchPoints", reason: "no readable touch points" });
  });

  it("excerpts the touch points a caller names instead of the plan's", () => {
    const packet = bootPacket(input({ touchPoints: [{ path: "packages/widget/src/model.ts", line: 30 }] }));

    expect(packet.text).toContain("### packages/widget/src/model.ts:15");
    expect(packet.text).not.toContain("### packages/widget/src/parse.ts");
  });

  it("leaves out the task card when the task store has no such task", () => {
    const packet = bootPacket(input({ task: { id: "WG-99" } }));

    expect(packet.omitted).toContainEqual({ id: "task", reason: "task WG-99 not found" });
  });
});
