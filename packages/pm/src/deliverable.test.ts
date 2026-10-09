import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  DeliverableSchema,
  deliverablePath,
  deliverablesDir,
  parseDeliverableRegistry,
  type Deliverable,
} from "./deliverable.js";

const deliverable: Deliverable = {
  id: "console-v1",
  title: "Console v1",
  done_when: "the console shows every active deliverable",
  target: "2026-11-30",
  status: "active",
  owner_seat: "example-seat",
  tags: ["console"],
  created: "2026-10-08",
  updated: "2026-10-08",
  shipped_at: null,
};

const messages = (input: unknown): string[] =>
  DeliverableSchema.safeParse(input).error?.issues.map((i) => i.message) ?? [];

describe("DeliverableSchema", () => {
  it("accepts a deliverable written as YAML", () => {
    const yaml = [
      "id: console-v1",
      "title: Console v1",
      "done_when: the console shows every active deliverable",
      "target: 2026-11-30",
      "status: active",
      "owner_seat: example-seat",
      "tags: [console]",
      "created: 2026-10-08",
      "updated: 2026-10-08",
      "shipped_at: null",
    ].join("\n");
    expect(DeliverableSchema.parse(parse(yaml))).toEqual(deliverable);
  });

  it("accepts a null target", () => {
    expect(DeliverableSchema.safeParse({ ...deliverable, target: null }).success).toBe(true);
  });

  it.each(["2026-02-30", "2026-1-05", "next week"])("rejects target %j", (target) => {
    expect(DeliverableSchema.safeParse({ ...deliverable, target }).success).toBe(false);
  });

  it.each(["planned", "active", "dropped"])("accepts status %s without shipped_at", (status) => {
    expect(DeliverableSchema.safeParse({ ...deliverable, status }).success).toBe(true);
  });

  it("rejects a status outside planned, active, shipped and dropped", () => {
    expect(DeliverableSchema.safeParse({ ...deliverable, status: "open" }).success).toBe(false);
  });

  it("accepts a shipped deliverable with its shipped_at date", () => {
    const shipped = { ...deliverable, status: "shipped", shipped_at: "2026-11-20" };
    expect(DeliverableSchema.safeParse(shipped).success).toBe(true);
  });

  it("rejects a shipped deliverable without shipped_at", () => {
    expect(messages({ ...deliverable, status: "shipped" })).toContain("shipped_at is set exactly when status is shipped");
  });

  it("rejects shipped_at on a deliverable that has not shipped", () => {
    expect(messages({ ...deliverable, shipped_at: "2026-11-20" })).toContain(
      "shipped_at is set exactly when status is shipped",
    );
  });

  it.each(["Console", "a", "relay-2", "A-b-C"])("accepts id %j", (id) => {
    expect(DeliverableSchema.safeParse({ ...deliverable, id }).success).toBe(true);
  });

  it.each(["2fa", "-console", "console_v1", "console.v1", ""])("rejects id %j", (id) => {
    expect(DeliverableSchema.safeParse({ ...deliverable, id }).success).toBe(false);
  });

  it.each(["title", "done_when", "owner_seat", "tags", "target", "shipped_at", "created", "updated"])(
    "rejects a deliverable missing %s",
    (key) => {
      const input: Record<string, unknown> = { ...deliverable };
      delete input[key];
      expect(DeliverableSchema.safeParse(input).success).toBe(false);
    },
  );
});

describe("deliverablesDir", () => {
  it("is the deliverables directory under the titan-platform initiative", () => {
    expect(deliverablesDir("/root/active")).toBe("/root/active/titan-platform/deliverables");
  });

  it("ignores a trailing slash on the root", () => {
    expect(deliverablesDir("/root/active/")).toBe("/root/active/titan-platform/deliverables");
  });

  it("names one yml file per deliverable id", () => {
    expect(deliverablePath("/root/active", "console-v1")).toBe(
      "/root/active/titan-platform/deliverables/console-v1.yml",
    );
  });

  it("refuses a path for an id that could leave the directory", () => {
    expect(() => deliverablePath("/root/active", "../tasks/TP-1")).toThrow();
  });
});

describe("parseDeliverableRegistry", () => {
  it("reads a missing directory, passed as no entries, as an empty registry", () => {
    expect(parseDeliverableRegistry([])).toEqual([]);
  });

  it("returns each file's deliverable", () => {
    const relay = { ...deliverable, id: "relay-v2", status: "planned" };
    const entries = [
      { file: "console-v1.yml", parsed: deliverable },
      { file: "relay-v2.yml", parsed: relay },
    ];
    expect(parseDeliverableRegistry(entries).map((d) => d.id)).toEqual(["console-v1", "relay-v2"]);
  });

  it("names the file that fails the schema", () => {
    const entries = [{ file: "console-v1.yml", parsed: { ...deliverable, status: "open" } }];
    expect(() => parseDeliverableRegistry(entries)).toThrow(/^console-v1\.yml: /);
  });

  it("rejects a file not named after the id it holds", () => {
    const entries = [{ file: "console.yml", parsed: deliverable }];
    expect(() => parseDeliverableRegistry(entries)).toThrow("console.yml: holds id console-v1");
  });

  it("rejects an empty file, which parses to null", () => {
    expect(() => parseDeliverableRegistry([{ file: "console-v1.yml", parsed: null }])).toThrow(/^console-v1\.yml/);
  });
});

// Item 90: tags are for retrieval only, so no pm code may select, order or lint on a deliverable tag.
describe("deliverable tags", () => {
  it("are never read as a deliverable: tag by any pm source file", () => {
    const srcDir = new URL("./", import.meta.url);
    const sources = readdirSync(srcDir).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"));
    const readers = sources.filter((name) => /deliverable:/i.test(readFileSync(new URL(name, srcDir), "utf8")));
    expect(sources.length).toBeGreaterThan(0);
    expect(readers).toEqual([]);
  });
});
