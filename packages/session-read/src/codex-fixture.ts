export const CODEX_THREAD = "child-thread";
export const CODEX_TREE = "root-thread";
export const CODEX_TURN = "child-turn-1";
export const CODEX_ROOT_TURN = "root-turn-1";

const usage = (input: number, output: number) => ({
  input_tokens: input,
  cached_input_tokens: Math.floor(input / 2),
  cache_write_input_tokens: 0,
  output_tokens: output,
  reasoning_output_tokens: Math.floor(output / 2),
  total_tokens: input + output,
});

export function codexFixtureRecords(): Record<string, unknown>[] {
  return [
    envelope("session_meta", {
      id: CODEX_THREAD,
      session_id: CODEX_TREE,
      parent_thread_id: CODEX_TREE,
      cli_version: "0.154.0-test",
      history_mode: "paginated",
      cwd: "/tmp/demo-a",
      future_metadata: { retained: true },
    }),
    envelope("event_msg", { type: "task_started", turn_id: CODEX_TURN, root_turn_id: CODEX_ROOT_TURN }),
    envelope("turn_context", {
      turn_id: CODEX_TURN,
      root_turn_id: CODEX_ROOT_TURN,
      model: "gpt-test",
      cwd: "/tmp/demo-a",
      future_turn_setting: "preserve-me",
    }),
    envelope("event_msg", { type: "user_message", message: "héllo 🌍" }),
    envelope("response_item", {
      type: "message",
      id: "message-user-1",
      role: "user",
      content: [{ type: "input_text", text: "héllo 🌍" }],
    }),
    envelope("event_msg", { type: "agent_message", message: "Working." }),
    envelope("response_item", {
      type: "message",
      id: "message-assistant-1",
      role: "assistant",
      content: [{ type: "output_text", text: "Working." }],
    }),
    envelope("response_item", { type: "custom_tool_call", id: "item-call-1", call_id: "call-1", name: "read_file", input: { path: "/tmp/é.txt" } }),
    envelope("response_item", { type: "function_call", id: "item-call-2", call_id: "call-2", name: "run", namespace: "functions", arguments: "{\"cmd\":\"pwd\"}" }),
    envelope("response_item", { type: "function_call_output", call_id: "call-2", output: "/tmp/demo-a" }),
    envelope("response_item", {
      type: "custom_tool_call_output",
      call_id: "call-1",
      output: [
        { type: "input_text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" },
        { type: "input_text", text: "cat: missing-fixture.txt: No such file or directory\nproofmarker\n" },
      ],
    }),
    envelope("token_usage_record", {
      response_id: "response-1",
      session_id: CODEX_TREE,
      thread_id: CODEX_THREAD,
      turn_id: CODEX_TURN,
      root_turn_id: CODEX_ROOT_TURN,
      usage: usage(10, 4),
      turn_token_usage: usage(10, 4),
      thread_token_usage: usage(10, 4),
    }),
    envelope("event_msg", { type: "token_count", info: { last_token_usage: usage(10, 4), total_token_usage: usage(10, 4) } }),
    envelope("token_usage_record", {
      response_id: "response-1",
      session_id: CODEX_TREE,
      thread_id: CODEX_THREAD,
      turn_id: CODEX_TURN,
      root_turn_id: CODEX_ROOT_TURN,
      usage: usage(10, 4),
      turn_token_usage: usage(10, 4),
      thread_token_usage: usage(10, 4),
    }),
    envelope("response_item", { type: "context_compaction", id: "compact-1", encrypted_content: "opaque-test-value" }),
    envelope("token_usage_record", {
      response_id: "response-2",
      session_id: CODEX_TREE,
      thread_id: CODEX_THREAD,
      turn_id: CODEX_TURN,
      root_turn_id: CODEX_ROOT_TURN,
      usage: usage(3, 2),
      turn_token_usage: usage(3, 2),
      thread_token_usage: usage(3, 2),
    }),
    envelope("event_msg", { type: "agent_message", message: "Projection-only completion." }),
    envelope("event_msg", { type: "task_complete", turn_id: CODEX_TURN, root_turn_id: CODEX_ROOT_TURN }),
    envelope("future_envelope", { future_value: 42 }),
  ].map((record, ordinal) => ({ ...record, ordinal }));
}

export function renderCodexRollout(records: readonly Record<string, unknown>[], trailingNewline = true): string {
  const text = records.map((record) => JSON.stringify(record)).join("\n");
  return trailingNewline ? `${text}\n` : text;
}

export function codexOffsetAfter(records: readonly Record<string, unknown>[], count: number): number {
  return Buffer.byteLength(renderCodexRollout(records.slice(0, count)), "utf8");
}

function envelope(type: string, payload: Record<string, unknown>): Record<string, unknown> {
  return { timestamp: "2026-09-11T10:00:00Z", type, payload };
}
