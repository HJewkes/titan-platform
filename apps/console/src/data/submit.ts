import { createContext, useCallback, useContext, useState } from "react";
import type { DataSource } from "@titan-design/rpc-client";
import type { ConsoleCommands } from "../../server/commands.js";
import { useInvalidate } from "./rpc.js";

type SubmitArgs = ConsoleCommands["rounds.submit"]["args"];
type SubmitResult = ConsoleCommands["rounds.submit"]["result"];

/** Where answers go: the daemon's live source, or null on an exported snapshot page, which can send nothing. */
const AnswerSource = createContext<DataSource | null>(null);
export const AnswerSourceProvider = AnswerSource.Provider;

export type SubmitState = { status: "idle" | "sending" } | { status: "sent"; result: SubmitResult } | { status: "failed"; error: string };

/** Sends one `rounds.submit`; on success the round is read again, so its status and recommendations follow the server. */
export function useSubmit(): { available: boolean; state: SubmitState; submit: (args: SubmitArgs) => Promise<void> } {
  const source = useContext(AnswerSource);
  const invalidate = useInvalidate();
  const [state, setState] = useState<SubmitState>({ status: "idle" });
  const submit = useCallback(
    async (args: SubmitArgs) => {
      if (source === null) return;
      setState({ status: "sending" });
      const envelope = await source.call("rounds.submit", args);
      if (!envelope.ok) return setState({ status: "failed", error: envelope.error });
      setState({ status: "sent", result: envelope.data as SubmitResult });
      invalidate(["rounds.get", "rounds.list"]);
    },
    [source, invalidate],
  );
  return { available: source !== null, state, submit };
}
