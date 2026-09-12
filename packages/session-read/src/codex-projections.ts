import type { ResumeBoundary, SourceLineEvidence } from "./normalized.js";

export interface PendingCodexProjection {
  role: "user" | "assistant";
  text: string;
  line: SourceLineEvidence;
  timestamp: string | null;
  path: readonly (string | number)[];
  boundary: ResumeBoundary;
}

/** Delays high-level message projections until a turn boundary so raw messages can supersede them. */
export class CodexProjectionBuffer {
  private readonly pending: PendingCodexProjection[] = [];

  get boundary(): ResumeBoundary | null {
    return this.pending[0]?.boundary ?? null;
  }

  add(projection: PendingCodexProjection): void {
    this.pending.push(projection);
  }

  match(role: "user" | "assistant", text: string): void {
    const index = this.pending.findIndex((item) => item.role === role && item.text === text);
    if (index >= 0) this.pending.splice(index, 1);
  }

  drain(): PendingCodexProjection[] {
    return this.pending.splice(0);
  }
}
