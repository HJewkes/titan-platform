import type { ReactNode } from "react";
import {
  Alert,
  Caption,
  EmptyState,
  Pill,
  type PillTone,
  Section,
  SectionContent,
  SectionHeader,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  VStack,
} from "@titan-design/react-ui";
import type { ArRunView, ArSnapshot, ArSync } from "../../server/autoresearch-view.js";
import { ExternalLink } from "./SessionFormat.js";
import { pullUrl, shortSha } from "./autoresearch-format.js";

const STATE_TONE: Record<ArSync["state"], PillTone> = { open: "neutral", merged: "success", closed: "error" };

const roundText = (round: number | "end"): string => (round === "end" ? "end" : `round ${round}`);

/**
 * Design G13a (C-256 S5): the snapshot PRs the run cut from its ratchet, a cut waiting behind the open one, and each
 * sync of the open PR. A sync's re-measure of B shows only here: it belongs to no idea's ladder.
 */
export function AutoresearchSnapshots({ run }: { run: ArRunView }): ReactNode {
  const { snapshots, snapshotPending, syncs } = run;
  return (
    <Section testID="autoresearch-snapshots">
      <SectionHeader title="Snapshots" subtitle="Ratchet snapshots cut as PRs, and each sync of the open one" />
      <SectionContent>
        <VStack gap={3}>
          {snapshotPending === null ? null : (
            <Alert status="info" testID="autoresearch-snapshot-pending" message={`A ${snapshotPending.trigger} snapshot is waiting for the open snapshot PR to settle`} />
          )}
          {snapshots.length === 0 ? <EmptyState title="The run has cut no snapshot" /> : <Snapshots repo={run.target.repo} snapshots={snapshots} />}
          {syncs.length === 0 ? null : <Syncs repo={run.target.repo} primary={run.target.metric.primary} syncs={syncs} />}
        </VStack>
      </SectionContent>
    </Section>
  );
}

function PullLink({ repo, pr, url }: { repo: string | undefined; pr: number; url?: string }): ReactNode {
  const href = pullUrl(repo, pr, url);
  return href === undefined ? `#${pr}` : <ExternalLink url={href}>{`#${pr}`}</ExternalLink>;
}

function Snapshots({ repo, snapshots }: { repo: string | undefined; snapshots: readonly ArSnapshot[] }): ReactNode {
  return (
    <Table density="dense" testID="autoresearch-snapshot-list">
      <TableHeader>
        <TableRow>
          <TableHeaderCell>Snapshot</TableHeaderCell>
          <TableHeaderCell>PR</TableHeaderCell>
          <TableHeaderCell>Trigger</TableHeaderCell>
          <TableHeaderCell>Cut after</TableHeaderCell>
          <TableHeaderCell>Head</TableHeaderCell>
        </TableRow>
      </TableHeader>
      <TableBody>
        {snapshots.map((cut) => (
          <TableRow key={cut.k} testID={`autoresearch-snapshot-${cut.k}`}>
            <TableCell>{`k${cut.k}`}</TableCell>
            <TableCell>
              <PullLink repo={repo} pr={cut.pr} url={cut.url} />
            </TableCell>
            <TableCell>{cut.trigger}</TableCell>
            <TableCell>{roundText(cut.round)}</TableCell>
            <TableCell>{shortSha(cut.sha)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function Syncs({ repo, primary, syncs }: { repo: string | undefined; primary: string; syncs: readonly ArSync[] }): ReactNode {
  return (
    <VStack gap={1}>
      <Caption>Syncs of the open snapshot PR</Caption>
      <Table density="dense" testID="autoresearch-syncs">
        <TableHeader>
          <TableRow>
            <TableHeaderCell>When</TableHeaderCell>
            <TableHeaderCell>PR</TableHeaderCell>
            <TableHeaderCell>State</TableHeaderCell>
            <TableHeaderCell>Held on</TableHeaderCell>
            <TableHeaderCell>Gate</TableHeaderCell>
            <TableHeaderCell>{`B re-measured, ${primary}`}</TableHeaderCell>
          </TableRow>
        </TableHeader>
        <TableBody>
          {syncs.map((sync) => (
            <SyncRow key={`${sync.round}-${sync.pr}`} repo={repo} primary={primary} sync={sync} />
          ))}
        </TableBody>
      </Table>
    </VStack>
  );
}

function SyncRow({ repo, primary, sync }: { repo: string | undefined; primary: string; sync: ArSync }): ReactNode {
  return (
    <TableRow testID={`autoresearch-sync-${sync.round}`}>
      <TableCell>{roundText(sync.round)}</TableCell>
      <TableCell>
        <PullLink repo={repo} pr={sync.pr} />
      </TableCell>
      <TableCell>
        <Pill variant="subtle" size="xs" tone={STATE_TONE[sync.state]}>
          {sync.treeChanged === true ? `${sync.state} · tree changed` : sync.state}
        </Pill>
      </TableCell>
      <TableCell>{heldText(sync)}</TableCell>
      <TableCell>{gateText(sync)}</TableCell>
      <TableCell>{sync.runs?.map((entry) => `${entry.repeat} ${entry.metrics[primary] ?? "—"}`).join(" · ") || "—"}</TableCell>
    </TableRow>
  );
}

function heldText({ conflict = [], frozen = [] }: ArSync): string {
  const parts = [...(conflict.length === 0 ? [] : [`conflict: ${conflict.join(", ")}`]), ...(frozen.length === 0 ? [] : [`frozen: ${frozen.join(", ")}`])];
  return parts.join(" · ") || "—";
}

/** The run's `end` sync opens no gate, so a held last sync shows none rather than one waiting forever. */
function gateText({ gate }: ArSync): string {
  if (gate === undefined) return "—";
  if (!gate.answered) return "waiting for the owner";
  return gate.resolved === undefined ? "answered" : `answered: ${shortSha(gate.resolved)}`;
}
