import { describe, expect, it } from "vitest";
import { compareCommits, compareFiles } from "./compare.js";
import { COMPARE_FILE_CAP } from "./port.js";
import type { Rest } from "./rest.js";

type Entry = { filename: string; previous_filename?: string };

function scriptedRest(files: Entry[]): Rest {
  const page = { merge_base_commit: { sha: "m".repeat(40) }, total_commits: 0, commits: [], files };
  const unused = async (): Promise<never> => {
    throw new Error("not scripted");
  };
  return {
    get: unused,
    getOrNull: unused,
    pages: async (_path, _fields, pick) => pick(page as never),
    revalidatePages: unused,
    text: unused,
    send: unused,
  };
}

const entries = (count: number): Entry[] => Array.from({ length: count }, (_, index) => ({ filename: `f${index}.ts` }));

describe.each([
  ["compareFiles", compareFiles],
  ["compareCommits", compareCommits],
])("%s", (_name, compare) => {
  it("lists the previous name of a renamed entry beside its new name", async () => {
    const rest = scriptedRest([{ filename: "new.ts", previous_filename: "old.ts" }, { filename: "same.ts" }]);

    const result = await compare(rest, "o/r", "a", "b");

    expect(result.files).toEqual(["new.ts", "old.ts", "same.ts"]);
  });

  it("is not truncated when renames push the name count past the cap but the entry count stays under it", async () => {
    const renamed = entries(COMPARE_FILE_CAP - 1).map((entry) => ({ ...entry, previous_filename: `old-${entry.filename}` }));

    const result = await compare(scriptedRest(renamed), "o/r", "a", "b");

    expect(result.files.length).toBe(2 * (COMPARE_FILE_CAP - 1));
    expect(result.truncated).toBe(false);
  });

  it("is truncated once the entry count reaches the cap", async () => {
    const result = await compare(scriptedRest(entries(COMPARE_FILE_CAP)), "o/r", "a", "b");

    expect(result.truncated).toBe(true);
  });
});
