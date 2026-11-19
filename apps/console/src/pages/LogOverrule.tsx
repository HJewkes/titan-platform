import { useState, type ReactNode } from "react";
import { Alert, Button, ButtonText, HStack, Typography, VStack } from "@titan-design/react-ui";
import type { LogRow } from "../../server/log-rows.js";
import { useInvalidate, type ServedCommands } from "../data/rpc.js";
import { useAnswerSource } from "../data/submit.js";
import { useWait } from "../shell/Loading.js";
import { PHONE_TAP } from "./phone.js";
import { useConfirmOnPhone } from "./PhoneConfirm.js";

type Overrulable = Extract<LogRow["reverse"], { kind: "overrule" }>;
type Options = ServedCommands["log.overrule-options"]["result"];
type Overruled = ServedCommands["log.overrule"]["result"];

type TapState =
  | { status: "idle" | "loading" | "sending" }
  | { status: "picking"; options: Options }
  | { status: "done"; result: Overruled }
  | { status: "failed"; error: string };

const NOTICE: Record<Overruled["notice"], string> = {
  sent: "the asker was told to reverse",
  failed: "telling the asker failed; tell it by hand",
  "not-wired": "no seat notifier is set, so tell the asker by hand",
};

const isObject = (data: unknown): data is Record<string, unknown> => typeof data === "object" && data !== null;
const isOptions = (data: unknown): data is Options => isObject(data) && Array.isArray(data.options) && "refusal" in data;
const isOverruled = (data: unknown): data is Overruled => isObject(data) && typeof data.from === "string" && typeof data.to === "string" && typeof data.notice === "string" && data.notice in NOTICE;
const UNEXPECTED = "the console answered an unexpected shape";

/** The tap's two calls: `log.overrule-options` loads the picks, `log.overrule` sends the owner's. Null on a snapshot page. */
function useOverrule(reverse: Overrulable): { state: TapState; load: () => Promise<void>; send: (optionId: string) => Promise<void> } | null {
  const source = useAnswerSource();
  const invalidate = useInvalidate();
  const [state, setState] = useState<TapState>({ status: "idle" });
  useWait(state.status === "loading" || state.status === "sending", true);
  if (source === null) return null;
  const subject = { source: reverse.source, id: reverse.id };
  const load = async (): Promise<void> => {
    setState({ status: "loading" });
    const envelope = await source.call("log.overrule-options", subject);
    if (!envelope.ok) return setState({ status: "failed", error: envelope.error });
    setState(isOptions(envelope.data) ? { status: "picking", options: envelope.data } : { status: "failed", error: UNEXPECTED });
  };
  const send = async (optionId: string): Promise<void> => {
    setState({ status: "sending" });
    const envelope = await source.call("log.overrule", { ...subject, optionId });
    if (!envelope.ok) return setState({ status: "failed", error: envelope.error });
    setState(isOverruled(envelope.data) ? { status: "done", result: envelope.data } : { status: "failed", error: UNEXPECTED });
    invalidate(["log.list"]);
  };
  return { state, load, send };
}

/**
 * The Overrule tap (TP-6778) on a round or deposit auto-by-rec answered: it lists the item's other picks, and the one the
 * owner takes goes to `log.overrule`, which records it and tells the asker to reverse. The first press only loads picks.
 */
export function OverruleTap({ rowKey, reverse }: { rowKey: string; reverse: Overrulable }): ReactNode {
  const tap = useOverrule(reverse);
  if (tap === null) return <OverruleButton rowKey={rowKey} isDisabled note="Overrule from the live console." />;
  const { state, load, send } = tap;
  if (state.status === "done") return <Alert status="success" message={`Overruled: ${state.result.from} → ${state.result.to}; ${NOTICE[state.result.notice]}.`} testID={`log-overruled-${rowKey}`} />;
  if (state.status === "picking") return <Picks rowKey={rowKey} options={state.options} onPick={(id) => void send(id)} />;
  return (
    <VStack gap={2}>
      <OverruleButton rowKey={rowKey} isDisabled={state.status !== "idle" && state.status !== "failed"} onPress={() => void load()} />
      {state.status === "failed" ? <Alert status="error" message={`Not overruled: ${state.error}`} /> : null}
    </VStack>
  );
}

function OverruleButton({ rowKey, isDisabled, onPress, note }: { rowKey: string; isDisabled: boolean; onPress?: () => void; note?: string }): ReactNode {
  return (
    <HStack gap={2} align="center" wrap>
      <Button size="sm" variant="outline" isDisabled={isDisabled} onPress={onPress} className={PHONE_TAP} testID={`log-overrule-${rowKey}`}>
        <ButtonText>Overrule</ButtonText>
      </Button>
      {note === undefined ? null : <Typography variant="caption" color="secondary">{note}</Typography>}
    </HStack>
  );
}

function Picks({ rowKey, options, onPick }: { rowKey: string; options: Options; onPick: (id: string) => void }): ReactNode {
  const others = options.options.filter((option) => !option.recommended);
  const taken = options.options.find((option) => option.recommended)?.label ?? "the recommendation";
  const actions = others.map((option) => ({ id: option.id, confirm: "Confirm", detail: `Overrule "${taken}" with "${option.label}"? The asker is told to reverse.`, isDisabled: options.refusal !== null, run: () => onPick(option.id) }));
  const { press, step } = useConfirmOnPhone(actions);
  if (options.refusal !== null) return <Alert status="warning" message={`Cannot overrule: ${options.refusal}`} testID={`log-overrule-refused-${rowKey}`} />;
  return (
    <VStack gap={2} testID={`log-overrule-picks-${rowKey}`}>
      <Typography variant="caption" color="secondary">{`Auto-by-rec took "${taken}". Pick instead:`}</Typography>
      <HStack gap={2} wrap>
        {others.map((option) => (
          <Button key={option.id} size="sm" variant="outline" className={PHONE_TAP} onPress={() => press(option.id)} testID={`log-overrule-pick-${rowKey}-${option.id}`}>
            <ButtonText>{option.label}</ButtonText>
          </Button>
        ))}
      </HStack>
      {step}
    </VStack>
  );
}
