import { readAssistantLine } from "./assistant-line.js";
import type { EventBase, LineSpan, SessionEvent, SessionPatch, SpanField } from "./events.js";
import { RELATIONS, artifactRef, branchRef, fileRef, prRef, repoForCwd, sessionRef, toRepoRelative } from "./refs.js";
import { asObject, int, searchText, str, type Json } from "./text.js";
import { IGNORED_PATH } from "./bash-parse.js";
import { readUserLine } from "./user-line.js";

export interface LineContext {
  line: Json;
  loc: LineSpan;
  sessionId: string;
  ts: string;
  cwd: string | null;
  gitBranch: string | null;
  repo: string | null;
}

export type Emit = (event: SessionEvent) => void;

/**
 * Translates one transcript JSONL line into typed events. Every rule is
 * stateless across lines, which is what makes an incremental read from a
 * watermark and a whole-file rebuild produce identical event sets.
 *
 * `fallbackSessionId` is the transcript's own filename stem, for line types
 * that carry no `sessionId`. `subagentId` marks a subagent sidechain, where a
 * line's `sessionId` names the dispatching parent rather than this session.
 */
export class LineReader {
  constructor(
    readonly emit: Emit,
    private readonly fallbackSessionId: string | null = null,
    private readonly subagentId: string | null = null,
  ) {}

  handle(line: Json, loc: LineSpan): void {
    const ownSessionId = str(line, "sessionId") ?? this.subagentId ?? this.fallbackSessionId;
    const sessionId = this.subagentId ?? ownSessionId;
    if (!sessionId) return;
    const branch = str(line, "gitBranch");
    const cwd = str(line, "cwd");
    const ctx: LineContext = {
      line,
      loc,
      sessionId,
      ts: str(line, "timestamp") ?? str(asObject(line.snapshot), "timestamp") ?? "",
      cwd,
      gitBranch: branch === "HEAD" ? null : branch,
      repo: repoForCwd(cwd),
    };
    this.observeSession(ctx);
    if (this.subagentId && ownSessionId && ownSessionId !== sessionId) this.spawnedBy(ctx, ownSessionId);
    this.dispatch(ctx, str(line, "type") ?? "unknown");
  }

  base(ctx: LineContext): EventBase {
    return { sessionId: ctx.sessionId, ts: ctx.ts, byteOffset: ctx.loc.byteOffset, byteLength: ctx.loc.byteLength };
  }

  fact(ctx: LineContext, eventType: string, toolUseId: string | null = null): void {
    const promptId = eventType === "user_prompt" ? str(ctx.line, "uuid") : null;
    this.emit({ ...this.base(ctx), kind: "fact", eventType, promptId, toolUseId });
  }

  span(ctx: LineContext, field: SpanField): void {
    this.emit({ ...this.base(ctx), kind: "span", field, text: searchText(asObject(ctx.line.message), field) });
  }

  session(ctx: LineContext, patch: SessionPatch, deltas: { turn?: number; commit?: number; push?: number } = {}): void {
    this.emit({ ...this.base(ctx), kind: "session", patch, turnDelta: deltas.turn ?? 0, commitDelta: deltas.commit ?? 0, pushDelta: deltas.push ?? 0 });
  }

  edge(ctx: LineContext, sourceRef: string, relation: string, targetRef: string): void {
    this.emit({ ...this.base(ctx), kind: "edge", sourceRef, relation, targetRef });
  }

  recordBranch(ctx: LineContext, name: string, repo = ctx.repo, base: string | null = null): void {
    const ref = branchRef(repo, name);
    this.emit({ ...this.base(ctx), kind: "branch", branchRef: ref, repo, name, base, deleted: false });
    this.edge(ctx, sessionRef(ctx.sessionId), RELATIONS.WORKED, ref);
  }

  /** A touched file, whether by a tool or by the human, becomes a file entity plus an edge. */
  recordFile(ctx: LineContext, rawPath: string, relation: string): { fileRef: string; path: string } | null {
    const { repo, path: relative } = toRepoRelative(rawPath);
    if (IGNORED_PATH.test(relative)) return null;
    const ref = fileRef(repo, relative);
    this.emit({ ...this.base(ctx), kind: "file", fileRef: ref, repo, path: relative });
    this.edge(ctx, sessionRef(ctx.sessionId), relation, ref);
    return { fileRef: ref, path: relative };
  }

  recordArtifact(ctx: LineContext, id: string, artifactKind: string, fields: { title: string | null; url: string | null; path: string | null }): void {
    const ref = artifactRef(id);
    this.emit({ ...this.base(ctx), kind: "artifact", artifactRef: ref, artifactKind, ...fields });
    this.edge(ctx, sessionRef(ctx.sessionId), RELATIONS.PRODUCED, ref);
  }

  private observeSession(ctx: LineContext): void {
    const patch: SessionPatch = {};
    const entrypoint = str(ctx.line, "entrypoint");
    const cliVersion = str(ctx.line, "version");
    if (entrypoint) patch.entrypoint = entrypoint;
    if (ctx.cwd) patch.cwd = ctx.cwd;
    if (cliVersion) patch.cliVersion = cliVersion;
    if (ctx.gitBranch) patch.gitBranch = ctx.gitBranch;
    this.session(ctx, patch);
    if (ctx.gitBranch) this.recordBranch(ctx, ctx.gitBranch);
  }

  /** Emitted per line on purpose: dedup happens downstream, and once-per-file would be cross-line state. */
  private spawnedBy(ctx: LineContext, parentSessionId: string): void {
    this.edge(ctx, sessionRef(parentSessionId), RELATIONS.SPAWNED, sessionRef(ctx.sessionId));
  }

  private dispatch(ctx: LineContext, type: string): void {
    switch (type) {
      case "pr-link":
        return this.prLink(ctx);
      case "ai-title":
        return this.typedField(ctx, "ai_title", "aiTitle");
      case "last-prompt":
        return this.typedField(ctx, "last_prompt", "lastPrompt");
      case "frame-link":
        return this.frameLink(ctx);
      case "mode":
        return this.phase(ctx, "mode", "mode");
      case "permission-mode":
        return this.phase(ctx, "permission-mode", "permissionMode");
      case "attachment":
        return this.attachment(ctx);
      case "file-history-snapshot":
        return this.fileHistorySnapshot(ctx);
      case "system":
        return this.fact(ctx, `system_${str(ctx.line, "subtype") ?? "event"}`);
      case "user":
        return readUserLine(this, ctx);
      case "assistant":
        return readAssistantLine(this, ctx);
      default:
        this.fact(ctx, type);
    }
  }

  private typedField(ctx: LineContext, eventType: string, key: "aiTitle" | "lastPrompt"): void {
    const value = str(ctx.line, key);
    if (value !== null) this.session(ctx, key === "aiTitle" ? { aiTitle: value } : { seedPrompt: value.slice(0, 240) });
    this.fact(ctx, eventType);
  }

  private prLink(ctx: LineContext): void {
    this.fact(ctx, "pr_link");
    const repo = str(ctx.line, "prRepository");
    const number = int(ctx.line, "prNumber");
    if (!repo || number <= 0) return;
    const ref = prRef(repo, number);
    this.emit({ ...this.base(ctx), kind: "pr", prRef: ref, number, repo, title: str(ctx.line, "title"), url: str(ctx.line, "prUrl") });
    this.edge(ctx, sessionRef(ctx.sessionId), RELATIONS.LINKED, ref);
  }

  private frameLink(ctx: LineContext): void {
    this.fact(ctx, "frame_link");
    const url = str(ctx.line, "frameUrl");
    if (!url) return;
    this.recordArtifact(ctx, url, "frame", { title: str(ctx.line, "title"), url, path: str(ctx.line, "path") });
  }

  private phase(ctx: LineContext, trigger: "mode" | "permission-mode", key: string): void {
    this.fact(ctx, trigger === "mode" ? "mode" : "permission_mode");
    const toMode = str(ctx.line, key);
    if (toMode) this.emit({ ...this.base(ctx), kind: "phase", trigger, toMode });
  }

  /** `edited_text_file` is the only signal that a human, not Claude, changed a file mid-session. */
  private attachment(ctx: LineContext): void {
    this.fact(ctx, "attachment");
    const attachment = asObject(ctx.line.attachment);
    const filename = str(attachment, "filename");
    if (str(attachment, "type") !== "edited_text_file" || !filename) return;
    const file = this.recordFile(ctx, filename, RELATIONS.EDITED_BY_HUMAN);
    if (file) this.emit({ ...this.base(ctx), kind: "human_edit", filePath: file.path });
  }

  /** `trackedFileBackups` is full state that repeats on every snapshot; downstream dedup makes that a no-op. */
  private fileHistorySnapshot(ctx: LineContext): void {
    this.fact(ctx, "file_history_snapshot");
    const backups = asObject(asObject(ctx.line.snapshot)?.trackedFileBackups);
    if (!backups) return;
    for (const [absolutePath, value] of Object.entries(backups)) {
      const entry = asObject(value);
      const backupFileName = str(entry, "backupFileName");
      const backupTime = str(entry, "backupTime");
      if (!backupFileName || !backupTime) continue;
      const { path: relative } = toRepoRelative(absolutePath);
      if (IGNORED_PATH.test(relative)) continue;
      this.emit({ ...this.base(ctx), kind: "file_checkpoint", filePath: relative, backupFileName, version: int(entry, "version"), backupTime });
    }
  }
}
