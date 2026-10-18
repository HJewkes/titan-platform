import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Alert, Button, ButtonText, Drawer, DrawerBody, DrawerFooter, Spinner, Typography, VStack } from "@titan-design/react-ui";
import type { JsonEnvelope } from "@titan-design/registry";
import type { ConsoleCommands } from "../../server/commands.js";
import { useInvalidate } from "../data/rpc.js";
import { useAnswerSource } from "../data/submit.js";

type Prepared = ConsoleCommands["inbox.prepare"]["result"];
type Ready = Extract<Prepared, { status: "ready" }>;
/** `inbox.act` is an owner-write, whose classed command erases its result type, so the page reads only what it shows. */
interface Acted {
  outcome: { status: string };
  message: string;
}

type Sheet = { status: "reading" } | { status: "refused"; reason: string } | { status: "ready"; prepared: Ready } | { status: "acting"; prepared: Ready } | { status: "acted"; prepared: Ready; acted: Acted } | { status: "failed"; prepared?: Ready; error: string };

const LANDED = new Set(["resolved", "released", "already"]);

const isRecord = (data: unknown): data is Record<string, unknown> => typeof data === "object" && data !== null;
const isPrepared = (data: unknown): data is Prepared => isRecord(data) && (data.status === "ready" || data.status === "no-action");
const isActed = (data: unknown): data is Acted => isRecord(data) && typeof data.message === "string" && isRecord(data.outcome) && typeof data.outcome.status === "string";
const UNEXPECTED = "the console sent an answer this page does not read";

const secondsSince = (at: string, now: number = Date.now()): number => Math.max(0, Math.round((now - Date.parse(at)) / 1000));

function sheetOfPrepare(envelope: JsonEnvelope<unknown>): Sheet {
  if (!envelope.ok) return { status: "failed", error: envelope.error };
  const prepared = envelope.data;
  if (!isPrepared(prepared)) return { status: "failed", error: UNEXPECTED };
  return prepared.status === "ready" ? { status: "ready", prepared } : { status: "refused", reason: prepared.reason };
}

/** The two calls a tap makes: `inbox.prepare` as the sheet opens, `inbox.act` only on Confirm. */
function useTap(itemId: string): { sheet: Sheet; confirm: () => Promise<void> } {
  const source = useAnswerSource();
  const invalidate = useInvalidate();
  const [sheet, setSheet] = useState<Sheet>({ status: "reading" });
  useEffect(() => {
    if (source === null) return;
    let live = true;
    void source.call("inbox.prepare", { itemId }).then((envelope) => live && setSheet(sheetOfPrepare(envelope)));
    return () => {
      live = false;
    };
  }, [source, itemId]);
  const confirm = useCallback(async () => {
    if (source === null || sheet.status !== "ready") return;
    const { prepared } = sheet;
    setSheet({ status: "acting", prepared });
    const envelope = await source.call("inbox.act", { itemId, confirm: prepared.confirm });
    if (!envelope.ok) return setSheet({ status: "failed", prepared, error: envelope.error });
    const acted = envelope.data;
    if (!isActed(acted)) return setSheet({ status: "failed", prepared, error: UNEXPECTED });
    setSheet({ status: "acted", prepared, acted });
    invalidate(["inbox.list"]);
  }, [source, sheet, itemId, invalidate]);
  return { sheet, confirm };
}

interface InboxConfirmProps {
  itemId: string;
  verb: string;
  /** The terminal command shown when the console cannot take the tap, so the owner still has a way through. */
  command: string | undefined;
  onClose: () => void;
}

/** The confirm sheet: the read-back of what the tap does, then Confirm as the second tap. Cancel sends nothing. */
export function InboxConfirm({ itemId, verb, command, onClose }: InboxConfirmProps): ReactNode {
  const { sheet, confirm } = useTap(itemId);
  const done = sheet.status === "acted" || sheet.status === "failed" || sheet.status === "refused";
  return (
    <Drawer isOpen onClose={onClose} placement="bottom" size="xl" title={`${verb}?`} testID="inbox-confirm">
      <DrawerBody>
        <VStack gap={3}>
          <SheetBody sheet={sheet} command={command} />
        </VStack>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="outline" onPress={onClose} testID="inbox-confirm-cancel">
          <ButtonText>{done ? "Close" : "Cancel"}</ButtonText>
        </Button>
        {done ? null : (
          <Button color="success" isDisabled={sheet.status !== "ready"} onPress={() => void confirm()} testID="inbox-confirm-ok">
            <ButtonText>Confirm</ButtonText>
          </Button>
        )}
      </DrawerFooter>
    </Drawer>
  );
}

function SheetBody({ sheet, command }: { sheet: Sheet; command: string | undefined }): ReactNode {
  if (sheet.status === "reading") return <Spinner size="sm" label="Reading the live gate and head" />;
  if (sheet.status === "refused") return <TerminalFallback message={`The console cannot take this tap: ${sheet.reason}`} command={command} />;
  // The outcome leads, so a short phone sheet never scrolls it out of sight below the read-back.
  return (
    <>
      {sheet.status === "acting" ? <Spinner size="sm" label="Sending" /> : null}
      {sheet.status === "acted" ? <Alert status={LANDED.has(sheet.acted.outcome.status) ? "success" : "warning"} message={sheet.acted.message} testID="inbox-confirm-outcome" /> : null}
      {sheet.status === "failed" ? <TerminalFallback message={`Not done: ${sheet.error}`} command={command} /> : null}
      {sheet.prepared === undefined ? null : <ReadBack prepared={sheet.prepared} />}
    </>
  );
}

/** A gate or hold read-back, g10 included; only a gate's carries `gateId`, only a g10 hold's carries `confirmLabel`. */
type RepoReadBack = Extract<Ready["readBack"], { repo: string }>;

function ReadBack({ prepared }: { prepared: Ready }): ReactNode {
  const { readBack } = prepared;
  return (
    <VStack gap={2} testID="inbox-readback">
      {"confirmLabel" in readBack ? <Typography variant="subtitle2" testID="inbox-readback-label">{readBack.confirmLabel}</Typography> : null}
      <Typography variant="subtitle1">{readBack.effect}</Typography>
      {"repo" in readBack ? (
        <PrFacts readBack={readBack} readAt={prepared.readAt} />
      ) : (
        <>
          <Typography variant="body2">{readBack.title}</Typography>
          <Typography variant="body2">{readBack.question}</Typography>
        </>
      )}
    </VStack>
  );
}

function PrFacts({ readBack, readAt }: { readBack: RepoReadBack; readAt: string }): ReactNode {
  const ref = `${readBack.repo}#${readBack.pr}`;
  return (
    <>
      <Typography variant="body2">{readBack.title.includes(ref) ? readBack.title : `${ref}: ${readBack.title}`}</Typography>
      <Typography variant="mono">{`head ${readBack.headSha.slice(0, 7)}, matches the live head, read ${secondsSince(readAt)} s ago`}</Typography>
      {"gateId" in readBack && readBack.gateId !== undefined ? <Typography variant="caption" color="secondary">{`Gate ${readBack.gateId}`}</Typography> : null}
      {readBack.hold === undefined ? null : <Typography variant="caption" color="secondary">{`Hold: ${readBack.hold.reason}`}</Typography>}
    </>
  );
}

function TerminalFallback({ message, command }: { message: string; command: string | undefined }): ReactNode {
  return (
    <VStack gap={2}>
      <Alert status="warning" message={message} testID="inbox-confirm-error" />
      {command === undefined ? null : (
        <>
          <Typography variant="caption" color="secondary">Run on terminal:</Typography>
          <Typography variant="mono">{command}</Typography>
        </>
      )}
    </VStack>
  );
}
