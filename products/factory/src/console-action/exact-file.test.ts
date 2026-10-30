import type { RepoFile } from "@titan-design/github";
import { describe, expect, it } from "vitest";
import { gitBlobId } from "../approved-set.js";
import { exactFile, type ExactRow } from "./exact-file.js";
import { unexactLine } from "./exact-line.js";

const PATH = ".github/workflows/ci.yml";
const NO_PIN = undefined;
const ROWS = 20;

/** A file as GitHub answers it: its UTF-8-decoded content beside the blob sha of the bytes actually committed. */
const repoFile = (bytes: Buffer): RepoFile => ({ path: PATH, content: bytes.toString("utf8"), blobSha: gitBlobId(bytes) });
const text = (content: string): RepoFile => repoFile(Buffer.from(content, "utf8"));

/** The test's own reading of the rows: base lines minus the removed ones, with the added ones placed at their numbers. */
function applied(base: string, rows: readonly ExactRow[]): string {
  const removed = new Set(rows.filter((row) => row.side === "-").map((row) => row.n));
  const kept = (base.match(/[^\n]*\n|[^\n]+$/g) ?? []).filter((_, index) => !removed.has(index + 1));
  const added = rows.filter((row) => row.side === "+");
  for (const row of added) kept.splice(row.n - 1, 0, unexactLine(row.text));
  return kept.join("");
}

const numbered = (count: number, tag: string): string => Array.from({ length: count }, (_, index) => `line ${index} ${tag}\n`).join("");

describe("an exact file section", () => {
  const cases: { name: string; base: RepoFile | null; head: RepoFile | null; expected: "ready" | "missing" }[] = [
    { name: "a line over 300 characters", base: text("on: push\n"), head: text(`on: push\nrun: ${"x".repeat(320)}\n`), expected: "ready" },
    { name: "a CRLF to LF change", base: text("on: push\r\njobs: {}\r\n"), head: text("on: push\njobs: {}\n"), expected: "ready" },
    { name: "a trailing newline dropped", base: text("on: push\n"), head: text("on: push"), expected: "ready" },
    { name: "an added control character", base: text("on: push\n"), head: text("on: pu\u0008sh\n"), expected: "ready" },
    { name: "a file added at head", base: null, head: text("on: push\n"), expected: "ready" },
    { name: "an invalid UTF-8 byte", base: text("on: push\n"), head: repoFile(Buffer.from([0x6f, 0x6e, 0xff, 0x0a])), expected: "missing" },
    { name: "more changed lines than the card shows", base: text(numbered(25, "old")), head: text(numbered(25, "new")), expected: "missing" },
  ];

  it.each(cases)("$name shows rows that rebuild the head bytes, or reads missing", ({ base, head, expected }) => {
    const file = exactFile(PATH, base, head, NO_PIN, ROWS);

    const shown = typeof file === "string" ? "missing" : applied(base?.content ?? "", file.rows) === (head?.content ?? "") ? "ready" : "lossy";
    expect(shown).toBe(expected);
  });

  it("reads missing when the decoded head re-encodes to bytes other than its blob", () => {
    const head = repoFile(Buffer.from([0x6f, 0x6e, 0xc3, 0x28, 0x0a]));

    expect(exactFile(PATH, text("on: push\n"), head, NO_PIN, ROWS)).toEqual(expect.stringContaining("does not decode"));
  });

  it("reads missing for a listed path whose blob did not change, as a mode-only change", () => {
    expect(exactFile(PATH, text("on: push\n"), text("on: push\n"), NO_PIN, ROWS)).toEqual(expect.stringContaining("did not change"));
  });

  it("reads missing when the head blob is not the one the merge evidence pinned", () => {
    const pinned = text("on: pull_request\n").blobSha;

    expect(exactFile(PATH, text("on: push\n"), text("on: push_target\n"), pinned, ROWS)).toEqual(expect.stringContaining("not the blob the merge evidence pinned"));
  });

  it("shows a pinned head that matches its pin", () => {
    const head = text("on: pull_request\n");

    expect(exactFile(PATH, text("on: push\n"), head, head.blobSha, ROWS)).toMatchObject({ path: PATH, rows: [{ side: "-", n: 1 }, { side: "+", n: 1, text: "on: pull_request\\u{A}" }] });
  });
});
