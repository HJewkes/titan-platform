import { afterEach, describe, expect, it, vi } from "vitest";
import { answer, recorded } from "./answers.js";
import { twinSnapshot } from "./snapshot.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("a twin fixture", () => {
  // `pnpm typecheck` holds each directive below to an error: a fixture that drifts from its command cannot build.
  it("is typed by the command it answers", () => {
    const drifted = [
      // @ts-expect-error a field the command does not return
      answer("shepherd.waiting", {}, { owner: [], seat: [], extra: true }),
      // @ts-expect-error a field the command returns is missing
      answer("inbox.list", {}, { items: [], gaps: [], readAt: "2031-03-05T12:00:30.000Z" }),
      // @ts-expect-error a count given as text
      answer("agents.queue", {}, { items: [], hidden: {}, open: "1", generatedAt: 0 }),
      // @ts-expect-error args the command does not take
      answer("reviews.get", { slug: "widget-kit" }, { review: null }),
      // @ts-expect-error a command the console does not serve
      recorded("work.nothing", {}),
    ];

    expect(drifted.map((call) => call.command)).toEqual(["shepherd.waiting", "inbox.list", "agents.queue", "reviews.get", "work.nothing"]);
  });
});

describe("the twin snapshot", () => {
  it("is the same whatever the wall clock says", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.parse("2030-01-01T00:00:00.000Z") });
    const early = await twinSnapshot();
    vi.setSystemTime(Date.parse("2032-06-15T18:45:00.000Z"));
    const late = await twinSnapshot();

    expect(JSON.stringify(late)).toBe(JSON.stringify(early));
  });
});
