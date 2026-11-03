import { describe, expect, it } from "vitest";
import type { UpstreamSample } from "./recorder.js";
import { timedFetch } from "./timed-fetch.js";

function run(inner: typeof fetch, url = "http://127.0.0.1:1/rpc/needs.list?id=secret-x") {
  const samples: UpstreamSample[] = [];
  const timed = timedFetch("factory", { recordUpstream: (sample) => void samples.push(sample) }, inner);
  return { samples, call: () => timed(url, { method: "POST", body: '{"id":"secret-x"}' }) };
}

describe("timedFetch", () => {
  it("a caller's own abort is recorded as outcome timeout", async () => {
    const { samples, call } = run(() => Promise.reject(new DOMException("aborted", "AbortError")));

    await expect(call()).rejects.toThrow("aborted");

    expect(samples).toEqual([expect.objectContaining({ name: "factory:needs.list", outcome: "timeout", bytes: 0 })]);
  });

  it("a refused connection is recorded as outcome error", async () => {
    const { samples, call } = run(() => Promise.reject(new TypeError("fetch failed")));

    await expect(call()).rejects.toThrow("fetch failed");

    expect(samples).toEqual([expect.objectContaining({ outcome: "error" })]);
  });

  it("a non-2xx answer is recorded as outcome error and the caller still reads its body", async () => {
    const { samples, call } = run(() => Promise.resolve(new Response("nope", { status: 503 })));

    const response = await call();

    expect(await response.text()).toBe("nope");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(samples).toEqual([expect.objectContaining({ outcome: "error", bytes: 4 })]);
  });
});
