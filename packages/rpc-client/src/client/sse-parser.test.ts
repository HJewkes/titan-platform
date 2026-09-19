import { describe, expect, it } from "vitest";
import { createSseParser } from "./sse-parser.js";

describe("createSseParser", () => {
  it("assembles frames split across arbitrary chunks", () => {
    const parse = createSseParser();
    const text = "event: ready\ndata: connected\n\nevent: change\ndata: /repo\n\n";
    const frames = [...text].flatMap((char) => parse(char));
    expect(frames).toEqual([
      { event: "ready", data: "connected" },
      { event: "change", data: "/repo" },
    ]);
  });

  it("joins multi-line data, defaults the event name, and skips comments and ids", () => {
    const parse = createSseParser();
    expect(parse(": keepalive\nid: 7\ndata: one\ndata: two\n\n")).toEqual([{ event: "message", data: "one\ntwo" }]);
  });

  it("accepts CRLF line endings, including a CR and LF in different chunks", () => {
    const parse = createSseParser();
    expect([...parse("event: a\r"), ...parse("\ndata: 1\r\n\r\n")]).toEqual([{ event: "a", data: "1" }]);
  });

  it("drops a frame that carries no data line", () => {
    const parse = createSseParser();
    expect(parse("event: empty\n\n")).toEqual([]);
  });
});
