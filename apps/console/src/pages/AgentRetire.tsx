import { useState, type ReactNode } from "react";
import { Button, ButtonText, Typography, VStack } from "@titan-design/react-ui";
import type { ConsoleCommands } from "../../server/commands.js";
import { useAnswerSource } from "../data/submit.js";
import type { RosterEntry } from "./AgentParts.js";
import { AgentFacts } from "./InboxReadBack.js";
import { TapSheet, type TapCommands } from "./TapSheet.js";

type RetireReady = Extract<ConsoleCommands["taps.prepare"]["result"], { status: "ready" }>;

type RetireOffer = { offer: true } | { offer: false; hint: string | null };

/**
 * Whether the page offers Retire, and if not, what it says instead. The server's `retireOpOf` and the factory decide; this only
 * keeps a tap off the rows they always refuse. Never a forced retire: the roster carries no exit time to wait out the grace on.
 */
export function retireOfferOf(agent: RosterEntry): RetireOffer {
  if (agent.state === "retired" || agent.origin !== "spawned" || agent.agentId === null) return { offer: false, hint: null };
  if (agent.seat !== null && agent.seat === agent.name) return { offer: false, hint: "A seat is retired by its owner session." };
  if (agent.state !== "exited") return { offer: false, hint: `${agent.name} is ${agent.state}: retire a working agent at the terminal.` };
  return { offer: true };
}

const retireTap = (name: string): TapCommands => ({ prepare: "taps.prepare", act: "taps.act", args: { target: { kind: "retire-agent", name } }, invalidates: ["agents.roster"] });

const Hint = ({ text }: { text: string }): ReactNode => (
  <Typography variant="caption" color="secondary" testID="agent-retire-hint">
    {text}
  </Typography>
);

/** The agent page's Retire button and its confirm sheet; a retired, adopted or unknown agent shows nothing. */
export function AgentRetire({ agent }: { agent: RosterEntry }): ReactNode {
  const live = useAnswerSource() !== null;
  const [confirming, setConfirming] = useState(false);
  const offer = retireOfferOf(agent);
  if (!offer.offer) return offer.hint === null ? null : <Hint text={offer.hint} />;
  const command = `agent-chat agent retire ${agent.name}`;
  if (!live) return <Hint text={`This page is a snapshot: act from the live console, or run ${command} on the terminal.`} />;
  return (
    <VStack gap={2} align="start">
      <Button size="sm" onPress={() => setConfirming(true)} testID="agent-retire">
        <ButtonText>Retire</ButtonText>
      </Button>
      {confirming ? (
        <TapSheet<RetireReady>
          commands={retireTap(agent.name)}
          verb={`Retire ${agent.name}`}
          reading={`Reading ${agent.name} again`}
          command={command}
          renderReadBack={(prepared) => <RetireReadBack prepared={prepared} />}
          testID="agent-retire-confirm"
          onClose={() => setConfirming(false)}
        />
      ) : null}
    </VStack>
  );
}

function RetireReadBack({ prepared }: { prepared: RetireReady }): ReactNode {
  return (
    <VStack gap={2} testID="agent-retire-readback">
      <Typography variant="subtitle1">{prepared.readBack.effect}</Typography>
      <AgentFacts readBack={prepared.readBack} readAt={prepared.readAt} />
    </VStack>
  );
}
