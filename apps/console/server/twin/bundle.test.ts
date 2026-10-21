import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../../src/", import.meta.url));

describe("the browser bundle", () => {
  it("imports no twin fixture, so the synthetic autoresearch run stays out of the served page", async () => {
    const files = (await readdir(SRC, { recursive: true })).filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file));
    const sources = await Promise.all(files.map(async (file) => [file, await readFile(path.join(SRC, file), "utf8")] as const));

    expect(sources.filter(([, text]) => /from "[^"]*server\/twin\//.test(text)).map(([file]) => file)).toEqual([]);
  });
});
