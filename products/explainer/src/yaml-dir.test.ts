import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type * as Yaml from "yaml";
import { z } from "zod";
import { readYamlDir } from "./yaml-dir.js";

const yamlParse = vi.hoisted(() => ({ calls: 0 }));

vi.mock("yaml", async (importOriginal) => {
  const actual = await importOriginal<typeof Yaml>();
  return {
    ...actual,
    parse: (...args: Parameters<typeof actual.parse>) => {
      yamlParse.calls += 1;
      return actual.parse(...args);
    },
  };
});

const ItemSchema = z.object({ id: z.string(), tags: z.array(z.string()) });

function writeItem(dir: string, tags: string[]): void {
  writeFileSync(join(dir, "items", "alpha.yaml"), `id: alpha\ntags: [${tags.join(", ")}]\n`);
}

function itemsDir(tags: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "yaml-dir-"));
  mkdirSync(join(dir, "items"));
  writeItem(dir, tags);
  return dir;
}

const read = (dir: string) => readYamlDir(dir, "items", ItemSchema, (item) => item.id);

describe("readYamlDir", () => {
  it("parses an unchanged file once across repeated reads", () => {
    const dir = itemsDir(["one"]);
    yamlParse.calls = 0;

    const first = read(dir);
    const second = read(dir);

    expect(yamlParse.calls).toBe(1);
    expect(second.get("alpha")).toEqual(first.get("alpha"));
  });

  it("re-reads a file whose content changed since the last read", () => {
    const dir = itemsDir(["one"]);
    read(dir);

    writeItem(dir, ["two"]);
    const after = read(dir);

    expect(after.get("alpha")?.tags).toEqual(["two"]);
  });

  it("gives each read its own objects, so one caller's mutation never reaches the next", () => {
    const dir = itemsDir(["one"]);

    read(dir).get("alpha")?.tags.push("mutated");
    const next = read(dir);

    expect(next.get("alpha")?.tags).toEqual(["one"]);
  });
});
