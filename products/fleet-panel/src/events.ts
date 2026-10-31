import { isRecord } from "@titan-design/rpc-protocol/narrow";

/** One SSE frame from the broker's `/events`: `event` names it, `data` is its raw payload. */
export interface SseFrame {
  event: string;
  data: string;
}

/** Splits a byte stream, cut at arbitrary points, into SSE frames. Comments (heartbeats) are dropped. */
export class SseParser {
  private buffer = "";
  private event = "message";
  private data: string[] = [];

  push(chunk: string): SseFrame[] {
    this.buffer += chunk;
    const frames: SseFrame[] = [];
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      const frame = this.line(line);
      if (frame) frames.push(frame);
      newline = this.buffer.indexOf("\n");
    }
    return frames;
  }

  private line(line: string): SseFrame | null {
    if (line === "") return this.dispatch();
    if (line.startsWith(":")) return null;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") this.event = value;
    if (field === "data") this.data.push(value);
    return null;
  }

  private dispatch(): SseFrame | null {
    const frame = this.data.length === 0 ? null : { event: this.event, data: this.data.join("\n") };
    this.event = "message";
    this.data = [];
    return frame;
  }
}

/** The last `Status:` report an agent sent, as the fleet's report contract writes it. */
export interface StatusReport {
  word: string;
  pr: string | null;
  atMs: number;
}

interface LogRow {
  id: number;
  ts: number;
  kind: string;
  actor: string;
  target: string | null;
  body: string | null;
  meta: Record<string, string>;
}

const STATUS_LINE = /^Status:\s*([A-Z][A-Z_]*)/;
const PR_LINE = /^PR:\s*\S*?#(\d+)/m;

/** Only the string-valued keys: the broker writes meta as strings, and nothing else is read. */
function stringsOf(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

/** A frame's JSON payload, or null when it is not JSON. */
export function parseFrameData(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function logRow(data: string): LogRow | null {
  const row = parseFrameData(data);
  if (!isRecord(row)) return null;
  const { id, ts, kind, actor, target, body } = row;
  if (typeof id !== "number" || typeof ts !== "number" || typeof kind !== "string" || typeof actor !== "string") return null;
  return {
    id,
    ts,
    kind,
    actor,
    target: typeof target === "string" ? target : null,
    body: typeof body === "string" ? body : null,
    meta: stringsOf(row.meta),
  };
}

export function statusReportOf(body: string, atMs: number): StatusReport | null {
  const word = STATUS_LINE.exec(body.trimStart())?.[1];
  if (word === undefined) return null;
  const pr = PR_LINE.exec(body)?.[1];
  return { word, pr: pr === undefined ? null : `#${pr}`, atMs };
}

/**
 * What the event log says about each agent, folded from `/events` frames: its newest Status
 * report and the task its spawn named. Rows replay in id order, so the newest write wins.
 */
export class EventBook {
  private readonly reports = new Map<string, StatusReport>();
  private readonly tasks = new Map<string, string>();
  private cursor = 0;

  /** The newest row id folded, for resuming `/events?since=`. */
  get latestId(): number {
    return this.cursor;
  }

  /** True when the frame changes something the panel shows. */
  accept(frame: SseFrame): boolean {
    if (frame.event === "session_status") return true;
    const row = logRow(frame.data);
    if (row === null || row.id <= this.cursor) return false;
    this.cursor = row.id;
    if (row.kind === "message" && row.body !== null) return this.report(row.actor, row.body, row.ts);
    if (row.kind === "agent_spawned") return this.task(row);
    return row.kind.startsWith("agent_");
  }

  /** A reset frame names the newest id; the replay that follows starts from there. */
  skipTo(latestId: number): void {
    this.cursor = Math.max(this.cursor, latestId);
  }

  reportOf(name: string): StatusReport | null {
    return this.reports.get(name) ?? null;
  }

  taskOf(name: string): string | null {
    return this.tasks.get(name) ?? null;
  }

  private report(actor: string, body: string, atMs: number): boolean {
    const report = statusReportOf(body, atMs);
    if (report === null) return false;
    this.reports.set(actor, report);
    return true;
  }

  private task(row: LogRow): boolean {
    const name = row.meta.name ?? row.target;
    const task = row.meta.task;
    if (name === null || task === undefined || task === "") return true;
    this.tasks.set(name, task);
    return true;
  }
}
