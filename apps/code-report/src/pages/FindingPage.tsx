import type { ReactNode } from "react";
import { Alert, Card, DataRow, HStack, Section, SectionContent, SectionHeader } from "@titan-design/react-ui";
import type { CodeReadCommandMap } from "@titan-design/code-read/query";
import { CodeExcerpt } from "../components/CodeExcerpt.js";
import { ProvenanceBadge, SeverityBadge } from "../components/badges.js";
import { Note, QueryView } from "../components/QueryView.js";
import { formatNumber } from "../components/format.js";
import { CALLS } from "../data/calls.js";
import { useQuery } from "../data/rpc.js";
import { findingHref, nodeHref } from "../router.js";
import { useReport } from "../report-context.js";

type FindingResult = CodeReadCommandMap["finding.get"]["result"];

/** Evidence before prose: the excerpt and the measured value come ahead of the rule's explanation. */
export function FindingPage({ id }: { id: string }): ReactNode {
  const { snapshotId } = useReport();
  const finding = useQuery("finding.get", CALLS.finding(snapshotId, id));
  return (
    <QueryView result={finding} label="this finding">
      {(data) => (
        <div className="flex flex-col gap-6">
          <FindingHeader data={data} />
          <Section>
            <SectionHeader title="Evidence" />
            <SectionContent>
              <Evidence data={data} />
            </SectionContent>
          </Section>
          <Measured data={data} />
          <Section>
            <SectionHeader title="Why it was flagged" subtitle={`Rule ${data.rule.id} (${data.rule.type})`} />
            <SectionContent>
              <p className="m-0 text-sm">{data.why}</p>
            </SectionContent>
          </Section>
          <Related items={data.related} />
        </div>
      )}
    </QueryView>
  );
}

function FindingHeader({ data }: { data: FindingResult }): ReactNode {
  const { finding } = data;
  return (
    <header>
      <HStack gap={2} align="center">
        <SeverityBadge severity={finding.severity} />
        <ProvenanceBadge kind={finding.provenance.kind} source={finding.provenance.source} />
      </HStack>
      <h2 className="m-0 mt-2 text-lg font-semibold">{finding.message}</h2>
      <p className="m-0 mt-1 text-sm">
        On <a className="text-text-link" href={nodeHref(finding.node.id)}>{finding.node.path || finding.node.id}</a>
        {finding.destination && <>{" "}importing <a className="text-text-link" href={nodeHref(finding.destination.id)}>{finding.destination.id}</a></>}
      </p>
      <Note>This finding is derived from a check rule on read: it disappears if the rule or its threshold changes.</Note>
    </header>
  );
}

const MISSING_EXCERPT: Record<string, string> = {
  "changed-since-snapshot": "The file changed since this snapshot was indexed, so its lines are withheld rather than shown out of step. Re-index to see them.",
  "not-in-export": "This static export did not carry these lines.",
  "no-source": "This source serves no file text.",
  unreadable: "The file could not be read.",
};

function Evidence({ data }: { data: FindingResult }): ReactNode {
  const { excerpts } = useReport().describe.capabilities;
  if (data.excerpt) return <CodeExcerpt excerpt={data.excerpt} />;
  if (excerpts === "none") return <Alert status="info" message="This source serves no source text, so there is no excerpt. Serve the report from a daemon with a repo root to see the lines." />;
  const reason = data.excerptMissing ?? "no-source";
  return <Alert status={reason === "changed-since-snapshot" ? "warning" : "info"} message={MISSING_EXCERPT[reason] ?? `No excerpt: ${reason}.`} />;
}

function Measured({ data }: { data: FindingResult }): ReactNode {
  const { measured, finding } = data;
  if (measured.value === null && measured.threshold === null) return null;
  return (
    <Section>
      <SectionHeader title="Measured" subtitle={finding.metric ? `${finding.metric}, from code-graph` : undefined} />
      <SectionContent>
        <Card variant="outline" className="max-w-md p-3">
          <DataRow label="Value" value={formatNumber(measured.value)} />
          <DataRow label="Threshold" value={formatNumber(measured.threshold)} />
          <DataRow label="Past threshold" value={finding.excess === null ? "n/a" : `${formatNumber(finding.excess)}x`} />
          <DataRow label="Percentile among same-kind nodes" value={formatNumber(measured.percentile)} />
          <DataRow label="Sibling median" value={formatNumber(measured.siblingMedian)} />
        </Card>
      </SectionContent>
    </Section>
  );
}

function Related({ items }: { items: FindingResult["related"] }): ReactNode {
  return (
    <Section>
      <SectionHeader title="Related findings" subtitle="Same node or a graph neighbour" />
      <SectionContent>
        {items.length === 0 ? <Note>None.</Note> : (
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {items.map((f) => (
              <li key={f.id} className="flex items-center gap-2 text-sm">
                <SeverityBadge severity={f.severity} />
                <a className="text-text-link" href={findingHref(f.id)}>{f.message}</a>
              </li>
            ))}
          </ul>
        )}
      </SectionContent>
    </Section>
  );
}
