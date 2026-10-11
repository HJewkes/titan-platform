import { ownerItemSchema } from "@titan-design/owner-queue";
import { describe, expect, it, vi } from "vitest";
import { RUN_A, brokerSnapshot } from "../test-support/owner-queue.js";
import { TOKEN_HEADER, agentChatSource, type BrokerEndpoint } from "./agent-chat-source.js";
import { tally } from "./counts.js";
import { QueueReadError } from "./queue-read-error.js";

const SECRET = "test-token-not-real";

function endpoint(reply: (url: string, init: RequestInit) => Response | Promise<Response>, overrides: Partial<BrokerEndpoint> = {}) {
  const fetchFake = vi.fn(async (url: string | URL | Request, init?: RequestInit) => reply(String(url), init ?? {}));
  return { fetchFake, endpoint: { baseUrl: () => "http://127.0.0.1:7600", token: () => SECRET, fetch: fetchFake as typeof fetch, ...overrides } };
}

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });
const queueReply = () => endpoint(() => json({ items: brokerSnapshot() }));

async function readError(source: BrokerEndpoint): Promise<QueueReadError> {
  const error = await agentChatSource(source).open().catch((e: unknown) => e);
  expect(error).toBeInstanceOf(QueueReadError);
  return error as QueueReadError;
}

describe("agentChatSource open", () => {
  it("reads every open row with the token header and yields schema-valid items", async () => {
    const { endpoint: source, fetchFake } = queueReply();
    const items = await agentChatSource(source).open();
    expect(fetchFake).toHaveBeenCalledWith("http://127.0.0.1:7600/api/queue", expect.objectContaining({ headers: { [TOKEN_HEADER]: SECRET } }));
    expect(items).toHaveLength(brokerSnapshot().length);
    for (const item of items) expect(() => ownerItemSchema.parse(item)).not.toThrow();
  });

  it("splits the snapshot so notices and messages read as news, not asks", async () => {
    const items = await agentChatSource(queueReply().endpoint).open();
    expect(tally(items.map((item) => item.kind))).toBe("approve 3, decide 2, know 14");
    expect(tally(items.map((item) => item.lens))).toBe("blocking-agent 4, blocking-merge 1, fyi 14");
  });

  it("carries a shaped question's options, pick, task and run keys", async () => {
    const items = await agentChatSource(queueReply().endpoint).open();
    const question = items.find((item) => item.id === "chat:m-30")!;
    expect(question).toMatchObject({
      kind: "decide",
      door: "two-way",
      summary: `Which retry budget for run ${RUN_A}?`,
      options: [{ id: "two", label: "two" }, { id: "three", label: "three" }],
      recommended: { optionId: "three", by: "agent-0" },
      keys: ["task:EX-1", `run:${RUN_A}`],
      sources: [{ system: "agent-chat", ref: "m-30" }],
    });
    expect(question.context).toContain("If no answer: keep two");
  });

  it("makes permission prompts and endorsements one-way approvals", async () => {
    const items = await agentChatSource(queueReply().endpoint).open();
    const approvals = items.filter((item) => item.door === "one-way").map((item) => item.id);
    expect(approvals).toEqual(["chat:m-33", "chat:m-34"]);
  });

  it("yields exactly one one-way approve item for an approval_request row, naming its msg_id and never routed to the decider", async () => {
    const row = brokerSnapshot().find((r) => r.kind === "approval_request")!;
    const items = await agentChatSource(endpoint(() => json({ items: [row] })).endpoint).open();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "approve", door: "one-way", sources: [{ system: "agent-chat", ref: row.msgId }] });
    expect(items[0]!.route?.target).not.toBe("decider");
  });

  it("keeps a permission prompt or endorsement an approve item whatever item kind its meta carries", async () => {
    const rows = brokerSnapshot()
      .filter((r) => r.kind === "approval_request" || r.kind === "endorse_request")
      .map((r) => ({ ...r, meta: { ...r.meta, kind: "stalled" } }));
    const items = await agentChatSource(endpoint(() => json({ items: rows })).endpoint).open();
    expect(items.map((item) => [item.kind, item.door])).toEqual([["approve", "one-way"], ["approve", "one-way"]]);
  });
});

describe("agentChatSource read failures", () => {
  it("throws unauthorized on a refused token and never echoes the token", async () => {
    const error = await readError(endpoint(() => json({ error: "bad token" }, 403)).endpoint);
    expect(error.failure).toBe("unauthorized");
    expect(error.message).not.toContain(SECRET);
  });

  it("throws unauthorized without calling the broker when no token is on disk", async () => {
    const { endpoint: source, fetchFake } = endpoint(() => json({ items: [] }), { token: () => null });
    expect((await readError(source)).failure).toBe("unauthorized");
    expect(fetchFake).not.toHaveBeenCalled();
  });

  it("throws not-running when no broker port is recorded", async () => {
    expect((await readError(endpoint(() => json({ items: [] }), { baseUrl: () => null }).endpoint)).failure).toBe("not-running");
  });

  it("throws unreachable when the connection fails", async () => {
    const error = await readError(endpoint(() => Promise.reject(new Error("connect ECONNREFUSED"))).endpoint);
    expect(error.failure).toBe("unreachable");
  });

  it("throws on a server error or a body that is not a queue", async () => {
    expect((await readError(endpoint(() => json({}, 500)).endpoint)).failure).toBe("http");
    expect((await readError(endpoint(() => json({ items: [{ kind: "notice" }] })).endpoint)).failure).toBe("malformed");
  });
});

describe("agentChatSource resolve", () => {
  const answer = { by: { class: "owner-terminal", id: "owner", channel: "test" }, at: "2026-01-05T10:00:00Z" };

  it("posts an option pick as the answer text on the factory channel", async () => {
    const { endpoint: source, fetchFake } = endpoint(() => json({ ok: true }));
    expect(await agentChatSource(source).resolve("m-30", { ...answer, optionId: "three" })).toEqual({ ok: true });
    const [url, init] = fetchFake.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:7600/api/answer");
    expect(JSON.parse(String(init!.body))).toEqual({ msgId: "m-30", text: "three", channel: "factory" });
  });

  it("dismisses when the answer carries no text", async () => {
    const { endpoint: source, fetchFake } = endpoint(() => json({ ok: true }));
    await agentChatSource(source).resolve("m-1", answer);
    expect(fetchFake.mock.calls[0]![0]).toBe("http://127.0.0.1:7600/api/dismiss");
  });

  it("reports a second verdict as closed and a refusal as rejected", async () => {
    const closed = endpoint(() => json({ ok: false, reason: "m-30 is not an open item" })).endpoint;
    expect(await agentChatSource(closed).resolve("m-30", { ...answer, text: "yes" })).toEqual({ ok: false, reason: "closed" });
    const refused = endpoint(() => json({ ok: false, reason: "m-33 is a permission prompt; it is approved or denied, not answered" })).endpoint;
    expect(await agentChatSource(refused).resolve("m-33", { ...answer, text: "yes" })).toMatchObject({ ok: false, reason: "rejected" });
  });
});
