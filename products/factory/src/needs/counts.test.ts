import { describe, expect, it } from "vitest";
import { brokerSnapshot, gateSnapshot } from "../test-support/owner-queue.js";
import type { BrokerEndpoint } from "./agent-chat-source.js";
import { queueCounts } from "./counts.js";

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { stdout: (t: string) => void out.push(t), stderr: (t: string) => void err.push(t), env: {} } };
}

const broker = (response: Response | Error): BrokerEndpoint => ({
  baseUrl: () => "http://127.0.0.1:7600",
  token: () => "test-token-not-real",
  fetch: (async () => (response instanceof Error ? Promise.reject(response) : response)) as typeof fetch,
});

describe("queueCounts", () => {
  it("prints each source's open count split by kind and no item text", async () => {
    const { out, io } = capture();
    const code = await queueCounts(io, broker(new Response(JSON.stringify({ items: brokerSnapshot() }))), gateSnapshot());
    expect(code).toBe(0);
    expect(out.join("")).toBe(
      [
        "agent-chat /api/queue: 19 open",
        "  by broker kind: approval_request 1, endorse_request 1, message 5, notice 10, question 2",
        "  by owner kind: approve 3, decide 2, know 14",
        "  by lens: blocking-agent 4, blocking-merge 1, fyi 14",
        "factory hitl gates: 3 pending",
        "  by gate step: approve-merge 1, bare-gate 1, ci-failed 1",
        "",
      ].join("\n"),
    );
    expect(out.join("")).not.toContain("Example notice");
  });

  it("exits unavailable on a broker it cannot read, and still counts the gates", async () => {
    const { out, err, io } = capture();
    const code = await queueCounts(io, broker(new Error("connect ECONNREFUSED")), gateSnapshot());
    expect(code).toBe(69);
    expect(err.join("")).toMatch(/^agent-chat \/api\/queue: .*\(unreachable\)\n$/);
    expect(out.join("")).toMatch(/^factory hitl gates: 3 pending/);
  });
});
