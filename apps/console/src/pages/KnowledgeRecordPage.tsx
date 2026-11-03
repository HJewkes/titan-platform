import type { ReactNode } from "react";
import { Alert, BreadcrumbItem, Breadcrumbs, Card, CardContent, DateTime, FilePathLabel, HStack, Link, MarkdownProse, Pill, Spinner, Tab, TabList, Tabs, Typography, VStack } from "@titan-design/react-ui";
import { EXIT } from "@titan-design/registry";
import type { ConsoleCommands } from "../../server/commands.js";
import { useQuery } from "../data/rpc.js";
import { open } from "../router.js";
import { KnowledgeGraph } from "./KnowledgeGraph.js";
import { PHONE_TAP } from "./phone.js";

type KnowledgeRecord = ConsoleCommands["work.record"]["result"];

/**
 * One note or source, or with `?tab=graph` the graph around any ref: the Graph tab never reads the
 * record, so `#/knowledge/task:<id>?tab=graph` works for a task or session too.
 */
export function KnowledgeRecordPage({ recordRef, graph }: { recordRef: string; graph: boolean }): ReactNode {
  return (
    <VStack gap={4}>
      <Trail recordRef={recordRef} />
      <Tabs index={graph ? 1 : 0} onChange={(index) => open({ view: "knowledge", id: recordRef, ...(index === 1 ? { query: "tab=graph" } : {}) })}>
        <TabList>
          <Tab className={PHONE_TAP}>Record</Tab>
          <Tab className={PHONE_TAP}>Graph</Tab>
        </TabList>
      </Tabs>
      {graph ? <KnowledgeGraph center={recordRef} /> : <RecordRead recordRef={recordRef} />}
    </VStack>
  );
}

/** `MarkdownProse` and `FilePathLabel` until react-ui has the knowledge reader (TP-859). */
function RecordRead({ recordRef }: { recordRef: string }): ReactNode {
  const record = useQuery("work.record", { ref: recordRef });
  if (record.status === "loading") return <Spinner size="sm" label={`Loading ${recordRef}`} />;
  if (record.data === undefined) {
    const message = record.error.code === EXIT.NOINPUT ? `No record ${recordRef}` : `Could not load ${recordRef}: ${record.error.message}`;
    return <Alert status="error" message={message} />;
  }
  return <Reader record={record.data} />;
}

function Reader({ record }: { record: KnowledgeRecord }): ReactNode {
  return (
    <VStack gap={4}>
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
  // A ref is one long word, so only a break inside it keeps a phone from scrolling sideways, and react-native-web's rows do not shrink to let it.
  return (
    <div className="min-w-0 break-all [&_*]:min-w-0 [&_*]:shrink">
      <Breadcrumbs>
        <BreadcrumbItem onPress={() => open({ view: "knowledge" })}>Knowledge</BreadcrumbItem>
        <BreadcrumbItem isCurrentPage>{recordRef}</BreadcrumbItem>
      </Breadcrumbs>
    </div>
  );
}
