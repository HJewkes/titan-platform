import { describe, expect, it, vi } from "vitest";
import { ntfyPublish } from "./ntfy.js";

const TOPIC = "https://ntfy.example.test/synthetic-topic-9f2";

describe("ntfyPublish", () => {
  it("posts the message with title, click, tags and the bearer token from the token file", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
    const push = { url: TOPIC, tokenFile: "/srv/synthetic-owner/token" };
    await expect(ntfyPublish(push, { title: "T\nitle", message: "body", click: "http://c.example.test/", tags: ["a", "b"] }, { fetch: fetcher, readFile: () => " secret \n" })).resolves.toEqual({ ok: true });
    expect(fetcher).toHaveBeenCalledWith(TOPIC, { method: "POST", body: "body", headers: { Authorization: "Bearer secret", Title: "T itle", Click: "http://c.example.test/", Tags: "a,b" } });
  });

  it("returns a warning, never throws, and keeps the topic URL out of it", async () => {
    const boom = vi.fn().mockRejectedValue(new Error(`connect failed for ${TOPIC} (topic /synthetic-topic-9f2)`));
    const result = await ntfyPublish({ url: TOPIC }, { title: "t", message: "m" }, { fetch: boom });
    expect(result).toEqual({ ok: false, warning: "push failed: connect failed for <url> (topic <topic>)" });
    const unreadable = await ntfyPublish({ url: TOPIC, tokenFile: "/srv/synthetic-owner/none" }, { title: "t", message: "m" }, { readFile: () => { throw new Error("no token file"); } });
    expect(unreadable).toEqual({ ok: false, warning: "push failed: no token file" });
  });

  it("reports an HTTP failure by status alone", async () => {
    const failing = vi.fn().mockResolvedValue(new Response("", { status: 503 }));
    await expect(ntfyPublish({ url: TOPIC }, { title: "t", message: "m" }, { fetch: failing })).resolves.toEqual({ ok: false, warning: "push failed: HTTP 503" });
  });
});
