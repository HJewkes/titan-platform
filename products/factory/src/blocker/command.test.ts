import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli, type CliIo } from "../cli.js";

const SEAT = "seat-a";

function harness() {
  const inbox = mkdtempSync(join(tmpdir(), "blocker-inbox-"));
  const run = async (...argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const io: CliIo = { stdout: (text) => void out.push(text), stderr: (text) => void err.push(text), env: { XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), "cfg-")), TITAN_CONSOLE_INBOX_DIR: inbox } };
    const code = await runCli(["blocker", ...argv], io);
    return { code, out: out.join(""), err: err.join("") };
  };
  const raise = (slug: string, ...extra: string[]) => run("raise", "--as", SEAT, "--slug", slug, "--blocks", `lane ${slug}`, "--summary", `need a call on ${slug}`, ...extra);
  const deposits = () => readdirSync(inbox).filter((name) => name.endsWith(".json") && !name.endsWith(".answer.json"));
  return { inbox, run, raise, deposits };
}

describe("titan-factory blocker", () => {
  it("raise files a blocker deposit with since and blocks", async () => {
    const { inbox, raise, deposits } = harness();
    const before = Date.now();

    const first = await raise("ci-red", "--since", "6h");
    const again = await raise("ci-red");

    expect(first).toMatchObject({ code: 0, err: "" });
    expect(again).toMatchObject({ code: 0, out: expect.stringMatching(/^already raised deposit:/) });
    expect(deposits()).toHaveLength(1);
    const filed = JSON.parse(readFileSync(join(inbox, deposits()[0]!), "utf8"));
    expect(filed).toMatchObject({ asker: SEAT, kind: "do", keys: expect.arrayContaining(["blocker", `alarm:blocker:${SEAT}:ci-red`]) });
    expect(filed.blocker.blocks).toBe("lane ci-red");
    const sinceAgoHours = (before - Date.parse(filed.blocker.since)) / 3_600_000;
    expect(sinceAgoHours).toBeGreaterThan(5.99);
    expect(sinceAgoHours).toBeLessThan(6.01);
  });

  it("a sixth open raise by one asker is refused by the cap", async () => {
    const { raise, deposits } = harness();
    for (let n = 1; n <= 5; n++) expect((await raise(`lane-${n}`)).code).toBe(0);

    const sixth = await raise("lane-6");
    const repeat = await raise("lane-5");

    expect(sixth.code).toBe(65);
    expect(sixth.err).toMatch(`${SEAT} already has 5 open deposits`);
    expect(repeat.code).toBe(0);
    expect(deposits()).toHaveLength(5);
  });

  it("clear withdraws and logs the actor", async () => {
    const { inbox, run, raise } = harness();
    await raise("ci-red");

    const cleared = await run("clear", "--as", SEAT, "--slug", "ci-red", "--actor", "coord-b");
    const unknown = await run("clear", "--as", SEAT, "--slug", "ci-red", "--actor", "coord-b");

    expect(cleared).toMatchObject({ code: 0, out: expect.stringMatching(/^cleared deposit:/) });
    const log = readFileSync(join(inbox, "withdrawals.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(log).toEqual([expect.objectContaining({ op: "withdraw", by: SEAT, actor: "coord-b", reason: "resolved" })]);
    expect(unknown.code).toBe(66);
    expect((await run("list", "--json")).out).toBe("[]\n");
  });

  it("list --json shows only open blockers", async () => {
    const { run, raise } = harness();
    await raise("newer", "--since", "1h");
    await raise("older", "--since", "2d");
    await raise("gone");
    await run("clear", "--as", SEAT, "--slug", "gone", "--actor", SEAT);

    const listed = await run("list", "--json");
    const text = await run("list");

    expect(listed.code).toBe(0);
    expect(JSON.parse(listed.out).map((row: { blocks: string }) => row.blocks)).toEqual(["lane older", "lane newer"]);
    expect(text.out.split("\n")[0]).toMatch(/^48h\tseat-a\tlane older\tdeposit:/);
  });
});
