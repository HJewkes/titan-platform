import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli, type CliIo } from "../cli.js";
import { inboxLinkVia, type InboxLink } from "./link.js";

const SEAT = "seat-a";
/** The spool checks blocker.since against each file mtime, so the pinned clock stays at the real start time. */
const NOW = Date.now();

/** Without `inboxLink` the CLI runs its default deps, with no factory config, so no console argv is configured. */
function harness(inboxLink?: InboxLink) {
  const inbox = mkdtempSync(join(tmpdir(), "blocker-inbox-"));
  const run = async (...argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const io: CliIo = { stdout: (text) => void out.push(text), stderr: (text) => void err.push(text), env: { XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), "cfg-")), TITAN_CONSOLE_INBOX_DIR: inbox } };
    const code = inboxLink === undefined ? await runCli(["blocker", ...argv], io) : await runCli(["blocker", ...argv], io, { workflows: [], routes: [], inboxLink });
    return { code, out: out.join(""), err: err.join("") };
  };
  const raise = (slug: string, ...extra: string[]) => run("raise", "--as", SEAT, "--slug", slug, "--blocks", `lane ${slug}`, "--summary", `need a call on ${slug}`, ...extra);
  const deposits = () => readdirSync(inbox).filter((name) => name.endsWith(".json") && !name.endsWith(".answer.json"));
  return { inbox, run, raise, deposits };
}

describe("titan-factory blocker", () => {
  beforeEach(() => void vi.useFakeTimers({ toFake: ["Date"], now: NOW }));
  afterEach(() => void vi.useRealTimers());

  it("raise files a blocker deposit with since and blocks", async () => {
    const { inbox, raise, deposits } = harness();

    const first = await raise("ci-red", "--since", "6h");
    const again = await raise("ci-red");

    expect(first).toMatchObject({ code: 0, err: "" });
    expect(again).toMatchObject({ code: 0, out: expect.stringMatching(/^already raised deposit:/) });
    expect(deposits()).toHaveLength(1);
    const filed = JSON.parse(readFileSync(join(inbox, deposits()[0]!), "utf8"));
    expect(filed).toMatchObject({ asker: SEAT, kind: "do", keys: expect.arrayContaining(["blocker", `alarm:blocker:${SEAT}:ci-red`]) });
    expect(filed.blocker).toEqual({ since: new Date(NOW - 6 * 3_600_000).toISOString(), blocks: "lane ci-red" });
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

  it("raise prints the console inbox link after the id, and the id alone when the console gives none", async () => {
    const asked: string[] = [];
    const linked = harness(async (_env, id) => (asked.push(id), `https://console.example.test:7500/#/inbox/${encodeURIComponent(id)}`));
    const unlinked = harness(async () => undefined);

    const withLink = await linked.raise("ci-red", "--json");
    const repeat = await linked.raise("ci-red");
    const withoutLink = await unlinked.raise("ci-red");

    const { id, link } = JSON.parse(withLink.out);
    expect(asked).toEqual([id, id]);
    expect(link).toBe(`https://console.example.test:7500/#/inbox/${encodeURIComponent(id)}`);
    expect(repeat.out).toBe(`already raised ${id} ${link}\n`);
    expect(withoutLink.out).toBe(`raised ${id}\n`);
  });

  it("the inbox link comes from the configured titan-console argv, and a console that fails or prints no URL gives none", async () => {
    const prefix = ["/opt/node/bin/node", "/opt/titan-console/cli.js"];
    const seen: (readonly string[])[] = [];
    const answer = (status: number, stdout: string) => async (argv: readonly string[]) => (seen.push(argv), { status, stdout, stderr: "" });

    const ok = await inboxLinkVia(prefix, "deposit:ab", answer(0, "https://console.example.test:7500/#/inbox/deposit%3Aab\n"));
    const failed = await inboxLinkVia(prefix, "deposit:ab", answer(1, "https://console.example.test:7500/\n"));
    const noUrl = await inboxLinkVia(prefix, "deposit:ab", answer(0, "usage: titan-console\n"));
    const thrown = await inboxLinkVia(prefix, "deposit:ab", async () => Promise.reject(new Error("ENOENT")));
    const unconfigured = await inboxLinkVia(undefined, "deposit:ab", answer(0, "https://console.example.test:7500/\n"));

    expect(ok).toBe("https://console.example.test:7500/#/inbox/deposit%3Aab");
    expect(seen[0]).toEqual([...prefix, "inbox", "link", "deposit:ab"]);
    expect([failed, noUrl, thrown, unconfigured]).toEqual([undefined, undefined, undefined, undefined]);
    expect(seen).toHaveLength(3);
  });
});
