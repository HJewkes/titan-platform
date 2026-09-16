import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { dateOrderNotes, newestNotes } from "./date-order.js";

let root: string;

function note(slug: string, dir: string, name: string, body = "x"): void {
  const target = path.join(root, slug, dir);
  mkdirSync(target, { recursive: true });
  writeFileSync(path.join(target, name), body);
}

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "retrieval-eval-"));
  for (const day of ["01", "02", "03", "04", "05", "06", "07"]) {
    note("live", "sources/notes", `2026-09-${day}-note.md`, "body".repeat(day === "07" ? 50 : 1));
  }
  note("live", "notes", "2026-09-09-legacy.md");
  note("retired", "sources/notes", "2026-01-01-old.md");
});

describe("newestNotes", () => {
  it("returns newest first, by the date the filename leads with", () => {
    const names = newestNotes(path.join(root, "live"), 3).map((file) => path.basename(file));
    expect(names).toEqual(["2026-09-09-legacy.md", "2026-09-07-note.md", "2026-09-06-note.md"]);
  });

  it("reads both the legacy notes dir and sources/notes", () => {
    const dirs = new Set(newestNotes(path.join(root, "live"), 5).map((file) => path.dirname(file)));
    expect(dirs.size).toBe(2);
  });

  it("honours the limit", () => {
    expect(newestNotes(path.join(root, "live"), 2)).toHaveLength(2);
  });

  it("returns nothing for an initiative with no notes", () => {
    expect(newestNotes(path.join(root, "absent"), 5)).toEqual([]);
  });
});

describe("dateOrderNotes", () => {
  const candidate = () => dateOrderNotes({ activeRoot: root });

  it("injects five on the spawn arm and twelve on the bootstrap arm", async () => {
    const spawn = await candidate().search("", 20, { arm: "spawn", initiative: "live" });
    const bootstrap = await candidate().search("", 20, { arm: "bootstrap", initiative: "live" });
    expect(spawn).toHaveLength(5);
    expect(bootstrap).toHaveLength(8);
  });

  it("ignores the query entirely, which is the behaviour under test", async () => {
    const one = await candidate().search("retrieval weights", 5, { arm: "spawn", initiative: "live" });
    const two = await candidate().search("something else", 5, { arm: "spawn", initiative: "live" });
    expect(one.map((hit) => hit.id)).toEqual(two.map((hit) => hit.id));
  });

  it("reports file size as the injected cost, not an excerpt", async () => {
    const hits = await candidate().search("", 1, { arm: "spawn", initiative: "live" });
    expect(hits[0]!.chars).toBeGreaterThan(0);
  });

  it("misses rather than throws when the initiative cannot be resolved", async () => {
    expect(await candidate().search("q", 5, { arm: "spawn" })).toEqual([]);
    expect(await candidate().search("q", 5, { arm: "spawn", initiative: "nope" })).toEqual([]);
  });

  it("is truncated by the runner's k, not only by its own count", async () => {
    expect(await candidate().search("", 2, { arm: "bootstrap", initiative: "live" })).toHaveLength(2);
  });
});
