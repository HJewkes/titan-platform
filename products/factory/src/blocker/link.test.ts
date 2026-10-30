import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli, type CliIo } from "../cli.js";
import { inboxLinkVia, type InboxLink } from "./link.js";

const CONSOLE = "https://console.example.test:7500";

function raiser(inboxLink: InboxLink) {
  const inbox = mkdtempSync(join(tmpdir(), "blocker-link-inbox-"));
  return async (...extra: string[]) => {
    const out: string[] = [];
    const io: CliIo = { stdout: (text) => void out.push(text), stderr: (text) => void out.push(text), env: { XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), "cfg-")), TITAN_CONSOLE_INBOX_DIR: inbox } };
    await runCli(["blocker", "raise", "--as", "seat-a", "--slug", "ci-red", "--blocks", "lane ci-red", "--summary", "need a call on ci-red", ...extra], io, { workflows: [], routes: [], inboxLink });
    return out.join("");
  };
}

describe("blocker inbox link", () => {
  it("raise prints the console inbox link after the id, and the id alone when the console gives none", async () => {
    const asked: string[] = [];
    const linked = raiser(async (_env, id) => (asked.push(id), `${CONSOLE}/#/inbox/${encodeURIComponent(id)}`));
    const unlinked = raiser(async () => undefined);

    const { id, link } = JSON.parse(await linked("--json"));
    const repeat = await linked();
    const withoutLink = await unlinked();

    expect(asked).toEqual([id, id]);
    expect(link).toBe(`${CONSOLE}/#/inbox/${encodeURIComponent(id)}`);
    expect(repeat).toBe(`already raised ${id} ${link}\n`);
    expect(withoutLink).toBe(`raised ${id}\n`);
  });

  it("the link comes from the configured titan-console argv, and a console that fails or prints no URL gives none", async () => {
    const prefix = ["/opt/node/bin/node", "/opt/titan-console/cli.js"];
    const seen: (readonly string[])[] = [];
    const answer = (status: number, stdout: string) => async (argv: readonly string[]) => (seen.push(argv), { status, stdout, stderr: "" });

    const ok = await inboxLinkVia(prefix, "deposit:ab", answer(0, `${CONSOLE}/#/inbox/deposit%3Aab\n`));
    const failed = await inboxLinkVia(prefix, "deposit:ab", answer(1, `${CONSOLE}/\n`));
    const noUrl = await inboxLinkVia(prefix, "deposit:ab", answer(0, "usage: titan-console\n"));
    const thrown = await inboxLinkVia(prefix, "deposit:ab", async () => Promise.reject(new Error("ENOENT")));
    const unconfigured = await inboxLinkVia(undefined, "deposit:ab", answer(0, `${CONSOLE}/\n`));

    expect(ok).toBe(`${CONSOLE}/#/inbox/deposit%3Aab`);
    expect(seen[0]).toEqual([...prefix, "inbox", "link", "deposit:ab"]);
    expect([failed, noUrl, thrown, unconfigured]).toEqual([undefined, undefined, undefined, undefined]);
    expect(seen).toHaveLength(3);
  });
});
