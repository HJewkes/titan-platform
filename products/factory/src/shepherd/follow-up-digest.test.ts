import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fileFollowUpDigest, followUpDigestPath, type DigestEntry } from "./follow-up-digest.js";

const NOW = Date.parse("2026-11-15T12:00:00Z");
const DAY = 86_400_000;
const entry = (title: string): DigestEntry => ({ title, severity: "low", done_when: `${title} is done.`, from_pr: "octo/widget#7", from_task: "DM-1", head: "a".repeat(40), reviewer: "rev-1" });
const rowAt = (title: string, daysAgo: number, promoted?: string) => ({ ...entry(title), at: new Date(NOW - daysAgo * DAY).toISOString(), ...(promoted && { promoted }) });

let root: string;
beforeEach(async () => void (root = await mkdtemp(join(tmpdir(), "follow-up-digest-"))));
afterEach(() => rm(root, { recursive: true, force: true }));

async function seed(rows: unknown[]): Promise<string> {
  const path = followUpDigestPath(root, "demo");
  await mkdir(join(root, "demo", "sources"), { recursive: true });
  await writeFile(path, rows.map((row) => `${JSON.stringify(row)}\n`).join(""));
  return path;
}

const titles = async (path: string) => (await readFile(path, "utf8")).trim().split("\n").map((line) => (JSON.parse(line) as { title: string }).title);

describe("the follow-up digest", () => {
  it("a write drops rows older than 4 weeks unless promoted to a task, and keeps the rest with the new row (TP-6714)", async () => {
    const path = await seed([rowAt("Stale nit", 29), rowAt("Promoted nit", 40, "DM-9"), rowAt("Recent nit", 27), rowAt("Edge nit", 28)]);
    const digest = fileFollowUpDigest(root, () => NOW);

    await digest.append("demo", [entry("New nit")]);

    expect(await titles(path)).toEqual(["Promoted nit", "Recent nit", "Edge nit", "New nit"]);
    expect(JSON.parse((await readFile(path, "utf8")).trim().split("\n").at(-1)!)).toEqual({ ...entry("New nit"), at: "2026-11-15T12:00:00.000Z" });
  });

  it("a first write creates the initiative's digest file, and an unreadable line is dropped rather than failing the write", async () => {
    const path = await seed(["not a row", rowAt("Recent nit", 1)]);
    const fresh = fileFollowUpDigest(root, () => NOW);

    await fresh.append("demo", [entry("New nit")]);
    await fresh.append("other", [entry("Elsewhere")]);

    expect(await titles(path)).toEqual(["Recent nit", "New nit"]);
    expect(await titles(followUpDigestPath(root, "other"))).toEqual(["Elsewhere"]);
  });
});
