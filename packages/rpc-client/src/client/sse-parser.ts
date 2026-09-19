import type { SseMessage } from "@titan-design/rpc-protocol";

/**
 * Incremental parser for `text/event-stream`. Feed it decoded text in any chunking; it
 * returns the frames completed so far. `id`, `retry`, and comment lines are ignored.
 */
export function createSseParser(): (chunk: string) => SseMessage[] {
  let buffer = "";
  let event = "";
  let data: string[] = [];

  function takeLine(line: string, out: SseMessage[]): void {
    if (line === "") {
      if (data.length > 0) out.push({ event: event || "message", data: data.join("\n") });
      event = "";
      data = [];
      return;
    }
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }

  return (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r\n|\n|\r(?!$)/);
    buffer = lines.pop() ?? "";
    const out: SseMessage[] = [];
    for (const line of lines) takeLine(line, out);
    return out;
  };
}
