import type { ReactNode } from "react";
import { DateTime, FilePathLabel, HStack, Link, Pill, Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, VStack } from "@titan-design/react-ui";
import type { ConsoleCommands } from "../../server/commands.js";
import { refToRoute } from "../refs.js";
import { open } from "../router.js";
import { useMediaQuery } from "./FramePins.js";
import { BELOW_MD } from "./phone.js";

type KnowledgeRow = ConsoleCommands["work.notes"]["result"]["records"][number];

/** The Browse list: cards on a phone, where five columns print each title over its kind; one tree, so each record renders once. */
export function KnowledgeTable({ records }: { records: readonly KnowledgeRow[] }): ReactNode {
  return useMediaQuery(BELOW_MD) ? <KnowledgeCards records={records} /> : <KnowledgeColumns records={records} />;
}

function KnowledgeCards({ records }: { records: readonly KnowledgeRow[] }): ReactNode {
  return (
    <VStack>
      {records.map((record) => (
        <KnowledgeCard key={record.ref} record={record} />
      ))}
    </VStack>
  );
}

/** A phone tap needs a 44px target, more than a line of link text gives it. */
const TAP_TARGET = "inline-flex min-h-11 items-center";

function KnowledgeCard({ record }: { record: KnowledgeRow }): ReactNode {
  return (
    <VStack gap={1} className="min-w-0 border-b border-divider py-inset-sm" testID={`knowledge-card-${record.ref}`}>
      <Link color="primary" className={`${TAP_TARGET} break-words`} onPress={() => openRef(record.ref)}>
        {record.title}
      </Link>
      <HStack gap={2} align="center" wrap>
        <KindPills record={record} />
        <Link className={TAP_TARGET} onPress={() => open({ view: "initiatives", id: record.slug })}>
          {record.slug}
        </Link>
      </HStack>
      <div className="min-w-0 break-all">
        <FilePathLabel path={record.file} size="sm" />
      </div>
      <DateTime value={record.changed} format="datetime" variant="caption" color="secondary" fallback="unknown" />
    </VStack>
  );
}

function KindPills({ record }: { record: KnowledgeRow }): ReactNode {
  return (
    <HStack gap={1}>
      <Pill variant="subtle" size="xs">
        {record.kind}
      </Pill>
      <Pill variant="subtle" size="xs">
        {record.type}
      </Pill>
    </HStack>
  );
}

/** `Table` and `FilePathLabel` until react-ui has the knowledge list (TP-859). */
function KnowledgeColumns({ records }: { records: readonly KnowledgeRow[] }): ReactNode {
  return (
    <Table density="dense">
      <TableHeader>
        <TableRow>
          <TableHeaderCell>Title</TableHeaderCell>
          <TableHeaderCell width={160}>Kind</TableHeaderCell>
          <TableHeaderCell width={180}>Initiative</TableHeaderCell>
          <TableHeaderCell>File</TableHeaderCell>
          <TableHeaderCell width={160}>Changed</TableHeaderCell>
        </TableRow>
      </TableHeader>
      <TableBody>
        {records.map((record) => (
          <KnowledgeTableRow key={record.ref} record={record} />
        ))}
      </TableBody>
    </Table>
  );
}

/** Opens a ref the way every other ref in the console opens. */
export function openRef(ref: string): void {
  const target = refToRoute(ref);
  if (target?.kind === "route") open(target.route);
}

function KnowledgeTableRow({ record }: { record: KnowledgeRow }): ReactNode {
  return (
    <TableRow testID={`knowledge-row-${record.ref}`}>
      <TableCell>
        <Link color="primary" onPress={() => openRef(record.ref)}>
          {record.title}
        </Link>
      </TableCell>
      <TableCell width={160}>
        <KindPills record={record} />
      </TableCell>
      <TableCell width={180}>
        <Link onPress={() => open({ view: "initiatives", id: record.slug })}>{record.slug}</Link>
      </TableCell>
      <TableCell>
        <FilePathLabel path={record.file} size="sm" />
      </TableCell>
      <TableCell width={160}>
        <DateTime value={record.changed} format="datetime" variant="caption" color="secondary" fallback="unknown" />
      </TableCell>
    </TableRow>
  );
}
