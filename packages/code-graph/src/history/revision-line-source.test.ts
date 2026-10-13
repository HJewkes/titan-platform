import { verifyCitation } from "@titan-design/evidence";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { revisionLineSource } from "./revision-line-source.js";
import { makeTestRepo, type TestRepo } from "./test-repo.js";

const numbered = (count: number): string => Array.from({ length: count }, (_, i) => `const line${i + 1} = ${i + 1};\n`).join("");

describe("revisionLineSource", () => {
  let repo: TestRepo;
  let pinned: string;

  beforeAll(async () => {
    repo = await makeTestRepo();
    await repo.write("a.ts", numbered(15));
    await repo.write("src/b.ts", "export const b = 1;\n");
    repo.commit("fifteen lines");
    pinned = repo.git(["rev-parse", "HEAD"]).trim();
    await repo.write("a.ts", numbered(25));
  });

  afterAll(() => repo.cleanup());

  it("reads the blob at the pinned commit, so a range only the working tree reaches is past EOF", () => {
    const source = revisionLineSource(repo.dir, pinned);
    const check = verifyCitation(source, { path: "a.ts", lineStart: 10, lineEnd: 20, quote: "const line10 = 10;" });

    expect(check).toMatchObject({ ok: false, reason: "past-eof", detail: "range ends at 20 but a.ts has 15 lines" });
  });

  it("verifies a citation inside the pinned blob", () => {
    const source = revisionLineSource(repo.dir, pinned);

    expect(verifyCitation(source, { path: "a.ts", lineStart: 10, lineEnd: 15, quote: "const line15 = 15;" }).ok).toBe(true);
  });

  it("still reports a reversed range as bad-range", () => {
    const check = verifyCitation(revisionLineSource(repo.dir, pinned), { path: "a.ts", lineStart: 9, lineEnd: 3, quote: "line3" });

    expect(check).toMatchObject({ ok: false, reason: "bad-range" });
  });

  it("reads a missing path, a directory or a cwd-relative path as unreadable", () => {
    const source = revisionLineSource(repo.dir, pinned);

    expect(source.lines("nope.ts")).toBeUndefined();
    expect(source.lines("src")).toBeUndefined();
    expect(source.lines("./a.ts")).toBeUndefined();
    expect(source.lines("src/b.ts")).toEqual(["export const b = 1;"]);
  });

  it("refuses a ref name or an abbreviated id, because those can move", () => {
    expect(() => revisionLineSource(repo.dir, "HEAD")).toThrow(/40-hex/);
    expect(() => revisionLineSource(repo.dir, pinned.slice(0, 12))).toThrow(/40-hex/);
  });

  it("refuses a 40-hex id that is not a commit in the repo", () => {
    expect(() => revisionLineSource(repo.dir, "0".repeat(40))).toThrow(/is not a commit/);
  });
});
