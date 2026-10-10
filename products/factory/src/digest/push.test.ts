import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { DigestSlot } from "./model.js";
import { pushDigest } from "./push.js";
import { deliverDigest } from "./run.js";

const SLOT: DigestSlot = { date: "2026-03-10", hour: "12" };
const URL_ = "https://ntfy.example/test-topic";
const MARKDOWN = "# Digest\n\n2 need you, 1 merged, 0 stuck\n\nextra line\n\n## Needs you\n1. ask";

const reply = (status: number): Response => new Response("", { status });
const headersOf = (call: unknown[]): Record<string, string> => (call[1] as { headers: Record<string, string> }).headers;

describe("pushDigest", () => {
  it("attaches the markdown with a filename, a dated title and the headline lines as the message", async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply(200));

    const warning = await pushDigest(MARKDOWN, SLOT, { url: URL_ }, { fetch: fetchMock });

    expect(warning).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(URL_);
    expect(init.method).toBe("PUT");
    expect(init.body).toBe(MARKDOWN);
    expect(init.headers).toMatchObject({ Title: "Digest 2026-03-10 12:00", Filename: "2026-03-10-12.md", Message: "Digest | 2 need you, 1 merged, 0 stuck | extra line" });
    expect(init.headers.Authorization).toBeUndefined();
  });

  it("warns on a non-2xx answer without naming the topic URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply(500));

    const warning = await pushDigest(MARKDOWN, SLOT, { url: URL_ }, { fetch: fetchMock });

    expect(warning).toBe("push failed: HTTP 500");
    expect(warning).not.toContain("test-topic");
  });

  it("falls back to a body truncated to 4 KB when the attachment is refused", async () => {
    const big = `${"é".repeat(5000)}\n`;
    const fetchMock = vi.fn().mockResolvedValueOnce(reply(413)).mockResolvedValueOnce(reply(200));

    const warning = await pushDigest(big, SLOT, { url: URL_ }, { fetch: fetchMock });

    expect(warning).toBeUndefined();
    const [, init] = fetchMock.mock.calls[1]!;
    expect(init.method).toBe("POST");
    expect(Buffer.byteLength(init.body)).toBeLessThanOrEqual(4096);
    expect(init.body.length).toBeGreaterThan(1000);
    expect(init.headers.Filename).toBeUndefined();
  });

  it("sends the bearer token read from tokenFile on both attempts", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(reply(400)).mockResolvedValueOnce(reply(200));
    const readFile = vi.fn().mockReturnValue("tk_example\n");

    await pushDigest(MARKDOWN, SLOT, { url: URL_, tokenFile: "/run/secrets/ntfy" }, { fetch: fetchMock, readFile });

    expect(readFile).toHaveBeenCalledWith("/run/secrets/ntfy");
    for (const call of fetchMock.mock.calls) expect(headersOf(call).Authorization).toBe("Bearer tk_example");
  });

  it("warns, without throwing or leaking the token, when the token file is unreadable", async () => {
    const fetchMock = vi.fn();

    const warning = await pushDigest(MARKDOWN, SLOT, { url: URL_, tokenFile: "/nonexistent/token" }, { fetch: fetchMock });

    expect(warning).toMatch(/^push failed: /);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("warns when the network throws", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error(`connect refused ${URL_}`));

    const warning = await pushDigest(MARKDOWN, SLOT, { url: URL_ }, { fetch: fetchMock });

    expect(warning).toBe("push failed: connect refused <url>");
  });
});

describe("deliverDigest push", () => {
  it("keeps the outDir file and reports a warning when the push fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-push-"));
    try {
      const fetchMock = vi.fn().mockResolvedValue(reply(503));

      const { written, warnings } = await deliverDigest("body", SLOT, { outDir: join(dir, "out"), copyDirs: [] }, { url: URL_ }, { fetch: fetchMock });

      expect(written).toEqual([join(dir, "out", "2026-03-10-12.md")]);
      expect(warnings).toEqual(["push failed: HTTP 503"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
