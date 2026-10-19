import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Alert, Button, ButtonText, Drawer, DrawerBody, DrawerFooter, Spinner, Typography, VStack } from "@titan-design/react-ui";
import type { JsonEnvelope } from "@titan-design/registry";
import { useInvalidate } from "../data/rpc.js";
import { useAnswerSource } from "../data/submit.js";

/** What every `*.prepare` answers: a read-back with a confirm digest, or the reason the console cannot take the tap. */
interface TapReady {
  status: "ready";
  confirm: string;
  readAt: string;
}
type Prepared<R extends TapReady> = R | { status: "no-action"; reason: string };
/** An `*.act` is an owner-write, whose classed command erases its result type, so the sheet reads only what it shows. */
interface Acted {
  outcome: { status: string };
  message: string;
}

type Sheet<R> = { status: "reading" } | { status: "refused"; reason: string } | { status: "ready"; prepared: R } | { status: "acting"; prepared: R } | { status: "acted"; prepared: R; acted: Acted } | { status: "failed"; prepared?: R; error: string };

const LANDED = new Set(["resolved", "released", "already"]);

const isRecord = (data: unknown): data is Record<string, unknown> => typeof data === "object" && data !== null;
const isPrepared = <R extends TapReady>(data: unknown): data is Prepared<R> => isRecord(data) && (data.status === "ready" || data.status === "no-action");
const isActed = (data: unknown): data is Acted => isRecord(data) && typeof data.message === "string" && isRecord(data.outcome) && typeof data.outcome.status === "string";
const UNEXPECTED = "the console sent an answer this page does not read";

function sheetOfPrepare<R extends TapReady>(envelope: JsonEnvelope<unknown>): Sheet<R> {
  if (!envelope.ok) return { status: "failed", error: envelope.error };
  const prepared = envelope.data;
  if (!isPrepared<R>(prepared)) return { status: "failed", error: UNEXPECTED };
  return prepared.status === "ready" ? { status: "ready", prepared } : { status: "refused", reason: prepared.reason };
}

/** The pair of commands a tap calls, and what to read again once it lands. `act` gets `prepare`'s args plus the confirm. */
export interface TapCommands {
  prepare: string;
  act: string;
  args: Record<string, unknown>;
  invalidates: Parameters<ReturnType<typeof useInvalidate>>[0];
}

/** The two calls a tap makes: the prepare as the sheet opens, the act only on Confirm. */
function useTap<R extends TapReady>({ prepare, act, args, invalidates }: TapCommands): { sheet: Sheet<R>; confirm: () => Promise<void> } {
  const source = useAnswerSource();
  const invalidate = useInvalidate();
  const [sheet, setSheet] = useState<Sheet<R>>({ status: "reading" });
  // Callers build `args` inline, so the effect keys on its bytes rather than its identity.
  const argsKey = JSON.stringify(args);
  useEffect(() => {
    if (source === null) return;
    let live = true;
    void source.call(prepare, JSON.parse(argsKey)).then((envelope) => live && setSheet(sheetOfPrepare<R>(envelope)));
    return () => {
      live = false;
    };
  }, [source, prepare, argsKey]);
  const confirm = useCallback(async () => {
    if (source === null || sheet.status !== "ready") return;
    const { prepared } = sheet;
    setSheet({ status: "acting", prepared });
    const envelope = await source.call(act, { ...JSON.parse(argsKey), confirm: prepared.confirm });
    if (!envelope.ok) return setSheet({ status: "failed", prepared, error: envelope.error });
    const acted = envelope.data;
    if (!isActed(acted)) return setSheet({ status: "failed", prepared, error: UNEXPECTED });
    setSheet({ status: "acted", prepared, acted });
    invalidate(invalidates);
  }, [source, sheet, act, argsKey, invalidate, invalidates]);
  return { sheet, confirm };
}

interface TapSheetProps<R extends TapReady> {
  commands: TapCommands;
  verb: string;
  /** What the spinner says while the prepare re-reads the live target. */
  reading: string;
  /** The terminal command shown when the console cannot take the tap, so the owner still has a way through. */
  command: string | undefined;
  renderReadBack: (prepared: R) => ReactNode;
  /** The prefix of every test id on the sheet. */
  testID: string;
  onClose: () => void;
}

/** The confirm sheet: the read-back of what the tap does, then Confirm as the second tap. Cancel sends nothing. */
export function TapSheet<R extends TapReady>({ commands, verb, reading, command, renderReadBack, testID, onClose }: TapSheetProps<R>): ReactNode {
  const { sheet, confirm } = useTap<R>(commands);
  const done = sheet.status === "acted" || sheet.status === "failed" || sheet.status === "refused";
  return (
    <Drawer isOpen onClose={onClose} placement="bottom" size="xl" title={`${verb}?`} testID={testID}>
      <DrawerBody>
        <VStack gap={3}>
          <SheetBody sheet={sheet} reading={reading} command={command} renderReadBack={renderReadBack} testID={testID} />
        </VStack>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="outline" onPress={onClose} testID={`${testID}-cancel`}>
          <ButtonText>{done ? "Close" : "Cancel"}</ButtonText>
        </Button>
        {done ? null : (
          <Button color="success" isDisabled={sheet.status !== "ready"} onPress={() => void confirm()} testID={`${testID}-ok`}>
            <ButtonText>Confirm</ButtonText>
          </Button>
        )}
      </DrawerFooter>
    </Drawer>
  );
}

type SheetBodyProps<R extends TapReady> = Pick<TapSheetProps<R>, "reading" | "command" | "renderReadBack" | "testID"> & { sheet: Sheet<R> };

function SheetBody<R extends TapReady>({ sheet, reading, command, renderReadBack, testID }: SheetBodyProps<R>): ReactNode {
  if (sheet.status === "reading") return <Spinner size="sm" label={reading} />;
  if (sheet.status === "refused") return <TerminalFallback message={`The console cannot take this tap: ${sheet.reason}`} command={command} testID={testID} />;
  // The outcome leads, so a short phone sheet never scrolls it out of sight below the read-back.
  return (
    <>
      {sheet.status === "acting" ? <Spinner size="sm" label="Sending" /> : null}
      {sheet.status === "acted" ? <Alert status={LANDED.has(sheet.acted.outcome.status) ? "success" : "warning"} message={sheet.acted.message} testID={`${testID}-outcome`} /> : null}
      {sheet.status === "failed" ? <TerminalFallback message={`Not done: ${sheet.error}`} command={command} testID={testID} /> : null}
      {sheet.prepared === undefined ? null : renderReadBack(sheet.prepared)}
    </>
  );
}

function TerminalFallback({ message, command, testID }: { message: string; command: string | undefined; testID: string }): ReactNode {
  return (
    <VStack gap={2}>
      <Alert status="warning" message={message} testID={`${testID}-error`} />
      {command === undefined ? null : (
        <>
          <Typography variant="caption" color="secondary">Run on terminal:</Typography>
          <Typography variant="mono">{command}</Typography>
        </>
      )}
    </VStack>
  );
}
