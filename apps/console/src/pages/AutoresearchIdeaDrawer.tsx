import { useState, type ReactNode } from "react";
import { Alert, Button, ButtonText, Card, CardContent, DataRow, Drawer, DrawerBody, Link, Spinner, Typography, VStack } from "@titan-design/react-ui";
import type { ArLadder, ArRound, ArRunView } from "../../server/autoresearch-view.js";
import { useQuery } from "../data/rpc.js";
import { href, open } from "../router.js";
import { AutoresearchIdeaRecord } from "./AutoresearchIdeaRecord.js";
import { AutoresearchStageStepper } from "./AutoresearchStageStepper.js";
import { RatchetMove } from "./AutoresearchRatchet.js";
import { depthSuffix, keptMove, reasonLabel } from "./autoresearch-format.js";
import { implementerRoute, stageSpans } from "./autoresearch-lanes.js";
import { PHONE_TAP, PHONE_TAP_BUTTONS, PHONE_TAP_ID_LINK } from "./phone.js";

/** Design §2.2 and §2.4: the card's detail, opened by `?idea=` so a reload or a shared link reopens it. */
export function AutoresearchIdeaDrawer({ run, ideaId, now }: { run: ArRunView; ideaId: string | undefined; now: number }): ReactNode {
  const found = ideaId === undefined ? undefined : findLadder(run, ideaId);
  if (found === undefined) return null;
  const { round, ladder } = found;
  const close = () => open({ view: "autoresearch", id: run.runId });
  return (
    <Drawer isOpen onClose={close} placement="right" size="lg" className={PHONE_TAP_BUTTONS} title={`${ladder.idea.id} · ${ladder.idea.cell}`} testID="autoresearch-idea-drawer">
      <DrawerBody scrollable>
        <VStack gap={4}>
          <IdeaFacts ladder={ladder} />
          <AutoresearchIdeaRecord run={run} ladder={ladder} />
          <AutoresearchStageStepper spans={stageSpans(ladder, now)} testID="autoresearch-drawer-stages" />
          <Typography variant="caption" color="secondary">
            A finished stage's time runs from the previous stage's end, until the run records each stage's start.
          </Typography>
          <IdeaLinks run={run} round={round} ladder={ladder} />
        </VStack>
      </DrawerBody>
    </Drawer>
  );
}

/** The newest ladder for the id, since a requeued idea runs again in a later round. */
function findLadder(run: ArRunView, ideaId: string): { round: ArRound; ladder: ArLadder } | undefined {
  for (const round of [...run.rounds].reverse()) {
    const ladder = round.ladders.find((entry) => entry.idea.id === ideaId);
    if (ladder !== undefined) return { round, ladder };
  }
  return undefined;
}

function IdeaFacts({ ladder }: { ladder: ArLadder }): ReactNode {
  const { idea, outcome } = ladder;
  return (
    <VStack gap={1}>
      <Typography variant="body2">{idea.hypothesis}</Typography>
      <DataRow label="Expected effect" value={`${idea.expectedEffect.metric} ${idea.expectedEffect.direction} · ${idea.expectedEffect.microSignal}`} />
      <DataRow label="Source" value={idea.source} />
      <DataRow
        label="Lineage"
        value={`${idea.parent === undefined ? idea.lineage : `${idea.lineage} (parent ${idea.parent})`}${depthSuffix(idea)}`}
        testID="autoresearch-drawer-lineage"
      />
      {idea.differsFrom === undefined ? null : <DataRow label="Differs from" value={idea.differsFrom} />}
      {outcome === null ? null : <DataRow label="Verdict" value={`${outcome.verdict} at ${outcome.rungReached} · ${reasonLabel(outcome.reason) ?? outcome.reason}`} />}
      {outcome?.lesson === undefined ? null : <DataRow label="Lesson" value={outcome.lesson} />}
    </VStack>
  );
}

/** Each link the read model can name; one it cannot yet says which record it waits on rather than vanish. */
function IdeaLinks({ run, round, ladder }: { run: ArRunView; round: ArRound; ladder: ArLadder }): ReactNode {
  const agent = ladder.implementer;
  const move = keptMove(round, ladder.outcome);
  return (
    <VStack gap={1} testID="autoresearch-drawer-links">
      <DataRow label="Implementer" value={<ImplementerLink ladder={ladder} />} />
      <DataRow label="Agent" value={agent === null ? "not recorded yet" : <AgentLink agent={agent.agent} />} />
      {agent?.resumedFrom === undefined ? null : <DataRow label="Resumed from" value={agent.resumedFrom} />}
      <DataRow label="Evals" value={evalsText(run, ladder)} />
      <DataRow label="Ratchet" value={move === null ? "did not move it" : <RatchetMove repo={run.target.repo} move={move} />} />
      <DataRow label="Snapshot PR" value="not recorded yet" />
      <IdeaDiff runId={run.runId} ladder={ladder} />
    </VStack>
  );
}

function AgentLink({ agent }: { agent: string }): ReactNode {
  const target = { view: "agents" as const, id: agent };
  return (
    <Link color="primary" className={PHONE_TAP_ID_LINK} href={href(target)} onPress={() => open(target)} testID="autoresearch-drawer-agent">
      {agent}
    </Link>
  );
}

/** The eval artifact directories are not on the read model yet, so this lists each run's primary value. */
function evalsText(run: ArRunView, ladder: ArLadder): string {
  const { primary } = run.target.metric;
  return ladder.evals.map((entry) => `${entry.repeat} ${entry.metrics[primary] ?? "—"}`).join(" · ") || "no eval run yet";
}

/** Fetched only on request: the patch can be large, and a running idea has none until its implement step returns. */
function IdeaDiff({ runId, ladder }: { runId: string; ladder: ArLadder }): ReactNode {
  const [shown, setShown] = useState(false);
  if (ladder.implementUsd === null) return <DataRow label="Diff" value="the implementer has not returned a head yet" />;
  if (!shown)
    return (
      <Button variant="outline" size="sm" className={PHONE_TAP} onPress={() => setShown(true)} testID="autoresearch-drawer-diff">
        <ButtonText>Show the diff</ButtonText>
      </Button>
    );
  return <DiffBody runId={runId} ideaId={ladder.idea.id} />;
}

/** Interim for TD-d (react-ui `CodeViewer` with a unified-diff mode): the patch as monospace text in a card. */
function DiffBody({ runId, ideaId }: { runId: string; ideaId: string }): ReactNode {
  const diff = useQuery("autoresearch.diff", { runId, ideaId });
  if (diff.status === "loading") return <Spinner size="sm" label="Loading the diff" />;
  if (diff.data === undefined) return <Alert status="error" message={`Could not load the diff: ${diff.error.message}`} />;
  const { stat, patch, truncated } = diff.data;
  return (
    <Card variant="subtle" testID="autoresearch-drawer-diff-body">
      <CardContent>
        <VStack gap={2}>
          <Typography variant="caption">{`${stat.files} files · +${stat.insertions} −${stat.deletions}${truncated ? " · patch cut short by the factory" : ""}`}</Typography>
          <Typography variant="mono" className="whitespace-pre-wrap break-all">{patch}</Typography>
        </VStack>
      </CardContent>
    </Card>
  );
}

/** The session log when the implement result names one, else the agent's page; nothing until the run names either. */
export function ImplementerLink({ ladder }: { ladder: ArLadder }): ReactNode {
  const target = implementerRoute(ladder.implementer);
  if (target === undefined) return <Typography variant="caption" color="secondary">implementer not recorded yet</Typography>;
  const label = target.view === "sessions" ? "Session log" : `Agent ${target.id}`;
  return (
    <Link color="primary" className={PHONE_TAP_ID_LINK} href={href(target)} onPress={() => open(target)} testID={`autoresearch-implementer-${ladder.idea.id}`}>
      {label}
    </Link>
  );
}
