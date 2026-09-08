import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nextOffset, readJsonLines, type RawLine } from "./json-lines.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "locator-lines-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function collect(file: string, start = 0): Promise<RawLine[]> {
  const out: RawLine[] = [];
  for await (const line of readJsonLines(file, start)) out.push(line);
  return out;
}

describe("readJsonLines", () => {
  it("yields exact byte offsets across multibyte and CRLF lines", async () => {
    const file = path.join(dir, "t.jsonl");
    writeFileSync(file, '{"a":"é"}\r\n{"b":2}\n');
    const lines = await collect(file);
    expect(lines.map((l) => [l.byteOffset, l.byteLength])).toEqual([
      [0, 11],
      [12, 7],
    ]);
    expect(lines[0]!.text).toBe('{"a":"é"}\r');
    expect(lines[1]!.text).toBe('{"b":2}');
  });

  it("withholds a trailing partial line so the watermark stays on a boundary", async () => {
    const file = path.join(dir, "t.jsonl");
    writeFileSync(file, '{"a":1}\n{"partial":');
    const lines = await collect(file);
    expect(lines).toHaveLength(1);
    expect(nextOffset(lines[0]!)).toBe(8);
  });

  it("resumes from a stored watermark without re-yielding earlier lines", async () => {
    const file = path.join(dir, "t.jsonl");
    writeFileSync(file, '{"a":1}\n{"b":2}\n{"c":3}\n');
    const first = await collect(file);
    const resumed = await collect(file, nextOffset(first[0]!));
    expect(resumed.map((l) => l.text)).toEqual(['{"b":2}', '{"c":3}']);
    expect(resumed[0]!.byteOffset).toBe(8);
  });

  it("yields nothing for an empty file", async () => {
    const file = path.join(dir, "t.jsonl");
    writeFileSync(file, "");
    expect(await collect(file)).toEqual([]);
  });
});
