/** Where in the transcript file the line that produced an event lives. */
export interface LineSpan {
  byteOffset: number;
  byteLength: number;
}

/** Every event names its session, its timestamp, and the line it came from. */
export interface EventBase extends LineSpan {
  sessionId: string;
  ts: string;
}

export type SpanField = "prompt" | "assistant_response" | "tool_input" | "tool_result";

/** Descriptive fields observed on a line; how they merge across lines is `fold.ts`'s job. */
export interface SessionPatch {
  entrypoint?: string;
  cwd?: string;
  cliVersion?: string;
  gitBranch?: string;
  aiTitle?: string;
  seedPrompt?: string;
}

export type SessionEvent =
  | (EventBase & { kind: "fact"; eventType: string; promptId: string | null; toolUseId: string | null })
  | (EventBase & { kind: "span"; field: SpanField; text: string })
  | (EventBase & { kind: "session"; patch: SessionPatch; turnDelta: number; commitDelta: number; pushDelta: number })
  | (EventBase & { kind: "turn"; promptId: string })
  | (EventBase & {
      kind: "usage";
      model: string;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
      thinkingTokens: number;
    })
  | (EventBase & { kind: "phase"; trigger: "mode" | "permission-mode"; toMode: string })
  | (EventBase & { kind: "human_edit"; filePath: string })
  | (EventBase & { kind: "file_checkpoint"; filePath: string; backupFileName: string; version: number; backupTime: string })
  | (EventBase & { kind: "pr"; prRef: string; number: number; repo: string; title: string | null; url: string | null })
  | (EventBase & { kind: "pr_merge"; number: number; repoHint: string | null })
  | (EventBase & { kind: "pr_create"; toolUseId: string; title: string | null; number: number | null; repo: string | null; url: string | null })
  | (EventBase & { kind: "branch"; branchRef: string; repo: string | null; name: string; base: string | null; deleted: boolean })
  | (EventBase & { kind: "file"; fileRef: string; repo: string | null; path: string })
  | (EventBase & { kind: "task"; taskRef: string; taskId: string; status: string | null })
  | (EventBase & { kind: "subagent"; agentRef: string; agentType: string | null; label: string | null })
  | (EventBase & { kind: "subagent_transcript"; agentRef: string; childSessionId: string })
  | (EventBase & { kind: "artifact"; artifactRef: string; artifactKind: string; title: string | null; url: string | null; path: string | null })
  | (EventBase & { kind: "edge"; sourceRef: string; relation: string; targetRef: string });

export type SessionEventKind = SessionEvent["kind"];
export type EventOf<K extends SessionEventKind> = Extract<SessionEvent, { kind: K }>;
