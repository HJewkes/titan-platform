import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readSessionText } from "./source-text.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("readSessionText", () => {
  it("reuses the legacy Claude field projection instead of returning raw JSON", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "titan-session-text-"));
    dirs.push(dir);
    const filePath = path.join(dir, "session.jsonl");
    const line = JSON.stringify({ message: { content: [{ type: "text", text: "Selected answer" }], private: "not returned" } });
    writeFileSync(filePath, `${line}\n`, "utf8");

    await expect(readSessionText({ path: filePath, byteOffset: 0, byteLength: Buffer.byteLength(line), field: "assistant_response" })).resolves.toBe(
      "Selected answer",
    );
  });

  it("returns null when the legacy source is unavailable", async () => {
    await expect(readSessionText({ path: "/missing/session.jsonl", byteOffset: 0, byteLength: 1, field: "prompt" })).resolves.toBeNull();
  });
});
