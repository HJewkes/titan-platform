import { useState, type ReactNode } from "react";
import { Button, ButtonText, Typography, VStack } from "@titan-design/react-ui";
import type { ConsoleCommands } from "../../server/commands.js";
import { useAnswerSource } from "../data/submit.js";
import type { RosterEntry } from "./AgentParts.js";
import { AgentFacts } from "./InboxReadBack.js";
import { TapSheet, type TapCommands, type TapConfirmChoice } from "./TapSheet.js";

type RetireReady = Extract<ConsoleCommands["taps.prepare"]["result"], { status: "ready" }>;

type RetireOffer = { offer: true } | { offer: false; hint: string | null };

/**
 * Whether the page offers Retire, and if not, what it says instead. The server's `retireOpOf` and the factory decide; this only
 * keeps a tap off the rows they always refuse. A forced retire is offered only from the plain sheet, once its read-back says
 * the exit is past agent-chat's grace.
 */
function retireOfferOf(agent: RosterEntry): RetireOffer {
  if (agent.state === "retired" || agent.origin !== "spawned" || agent.agentId === null) return { offer: false, hint: null };
  if (agent.seat !== null && agent.seat === agent.name) return { offer: false, hint: "A seat is retired by its owner session." };
  if (agent.state !== "exited") return { offer: false, hint: `${agent.name} is ${agent.state}: retire a working agent at the terminal.` };
  return { offer: true };
}

const retireTap = (name: string, force: boolean): TapCommands => ({
  prepare: "taps.prepare",
  act: "taps.act",
  args: { target: { kind: "retire-agent", name, ...(force && { force }) } },
  invalidates: ["agents.roster"],
});

const DISCARD: readonly TapConfirmChoice[] = [{ id: "discard", label: "Retire and discard", color: "error", args: {} }];

type Confirming = "plain" | "force" | null;

const Hint = ({ text }: { text: string }): ReactNode => (
  <Typography variant="caption" color="secondary" testID="agent-retire-hint">
    {text}
  </Typography>
);

/** The agent page's Retire button and its confirm sheet; a retired, adopted or unknown agent shows nothing. */
export function AgentRetire({ agent }: { agent: RosterEntry }): ReactNode {
  const live = useAnswerSource() !== null;
  const [confirming, setConfirming] = useState<Confirming>(null);
  const offer = retireOfferOf(agent);
  if (!offer.offer) return offer.hint === null ? null : <Hint text={offer.hint} />;
  const command = `agent-chat agent retire ${agent.name}`;
  if (!live) return <Hint text={`This page is a snapshot: act from the live console, or run ${command} on the terminal.`} />;
  return (
    <VStack gap={2} align="start">
      <Button size="sm" onPress={() => setConfirming("plain")} testID="agent-retire">
        <ButtonText>Retire</ButtonText>
      </Button>
      <RetireSheet name={agent.name} command={command} confirming={confirming} setConfirming={setConfirming} />
    </VStack>
  );
}

interface RetireSheetProps {
  name: string;
  command: string;
  confirming: Confirming;
  setConfirming: (next: Confirming) => void;
}

/** The plain sheet, or the forced one it hands over to; the forced sheet's only confirm is Retire and discard. */
function RetireSheet({ name, command, confirming, setConfirming }: RetireSheetProps): ReactNode {
  const close = () => setConfirming(null);
  if (confirming === "plain") {
    const renderReadBack = (prepared: RetireReady) => <RetireReadBack prepared={prepared} onForce={() => setConfirming("force")} />;
    return <TapSheet<RetireReady> commands={retireTap(name, false)} verb={`Retire ${name}`} reading={`Reading ${name} again`} command={command} renderReadBack={renderReadBack} testID="agent-retire-confirm" onClose={close} />;
  }
  if (confirming !== "force") return null;
  return (
    <TapSheet<RetireReady>
      commands={retireTap(name, true)}
      verb={`Retire ${name} and discard its work`}
      reading={`Reading ${name} again`}
      command={`${command} --force`}
      renderReadBack={(prepared) => <RetireReadBack prepared={prepared} />}
      choicesOf={() => DISCARD}
      testID="agent-retire-force"
      onClose={close}
    />
  );
}

const exitedLine = (exitedAt: string | null): string => (exitedAt === null ? "agent-chat reports no exit time" : `exited ${exitedAt}`);

/** The plain sheet offers force only when the server says the grace has passed, and says why not while it has not. */
function ForceOffer({ forceStop, onForce }: { forceStop: string | null | undefined; onForce: () => void }): ReactNode {
  if (forceStop === undefined) return null;
  if (forceStop !== null) {
    return (
      <Typography variant="caption" color="secondary" testID="agent-retire-force-stop">
        {`No forced retire: ${forceStop}`}
      </Typography>
    );
  }
  return (
    <Button size="sm" variant="outline" color="error" onPress={onForce} testID="agent-retire-force-open">
      <ButtonText>Retire and discard its work instead</ButtonText>
    </Button>
  );
}

function RetireReadBack({ prepared, onForce }: { prepared: RetireReady; onForce?: () => void }): ReactNode {
  return (
    <VStack gap={2} testID="agent-retire-readback">
      <Typography variant="subtitle1">{prepared.readBack.effect}</Typography>
      <Typography variant="mono" testID="agent-retire-exited">
        {exitedLine(prepared.readBack.exitedAt ?? null)}
      </Typography>
      <AgentFacts readBack={prepared.readBack} readAt={prepared.readAt} />
      {onForce === undefined ? null : <ForceOffer forceStop={prepared.forceStop} onForce={onForce} />}
    </VStack>
  );
}
