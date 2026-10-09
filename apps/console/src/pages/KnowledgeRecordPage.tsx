import type { ReactNode } from "react";
import { Alert, BreadcrumbItem, Breadcrumbs, Card, CardContent, DateTime, FilePathLabel, HStack, Link, MarkdownProse, Pill, Spinner, Typography, VStack } from "@titan-design/react-ui";
import { EXIT } from "@titan-design/registry";
import type { ConsoleCommands } from "../../server/commands.js";
import { useQuery } from "../data/rpc.js";
import { open } from "../router.js";

type KnowledgeRecord = ConsoleCommands["work.record"]["result"];

/** One note or source: `MarkdownProse` and `FilePathLabel` until react-ui has the knowledge reader (TP-859). */
export function KnowledgeRecordPage({ recordRef }: { recordRef: string }): ReactNode {
  const record = useQuery("work.record", { ref: recordRef });
  if (record.status === "loading") return <Spinner size="sm" label={`Loading ${recordRef}`} />;
  if (record.data === undefined) {
    const message = record.error?.code === EXIT.NOINPUT ? `No record ${recordRef}` : `Could not load ${recordRef}: ${record.error?.message ?? "no answer"}`;
    return (
      <VStack gap={4}>
        <Trail recordRef={recordRef} />
        <Alert status="error" message={message} />
      </VStack>
    );
  }
  return <Reader record={record.data} />;
}

function Reader({ record }: { record: KnowledgeRecord }): ReactNode {
  return (
    <VStack gap={4}>
      <Trail recordRef={record.ref} />
      <VStack gap={2}>
        <Typography variant="h2">{record.title}</Typography>
        <Meta record={record} />
      </VStack>
      {record.truncated ? <Alert status="info" size="compact" message="This file is longer than active-work's read cap; this is its head." /> : null}
      <Card>
        <CardContent>
          <MarkdownProse body={record.body} testID="knowledge-body" />
        </CardContent>
      </Card>
    </VStack>
  );
}

function Meta({ record }: { record: KnowledgeRecord }): ReactNode {
  return (
    <HStack gap={3} align="center" wrap>
      <Pill variant="subtle" size="xs">
        {record.type ? `${record.kind} · ${record.type}` : record.kind}
      </Pill>
      <Link color="primary" onPress={() => open({ view: "initiatives", id: record.slug })}>
        {record.slug}
      </Link>
      <FilePathLabel path={record.file} size="sm" />
      {record.created ? <DateTime value={record.created} format="date" variant="caption" color="secondary" /> : null}
    </HStack>
  );
}

function Trail({ recordRef }: { recordRef: string }): ReactNode {
  return (
    <Breadcrumbs>
      <BreadcrumbItem onPress={() => open({ view: "knowledge" })}>Knowledge</BreadcrumbItem>
      <BreadcrumbItem isCurrentPage>{recordRef}</BreadcrumbItem>
    </Breadcrumbs>
  );
}
