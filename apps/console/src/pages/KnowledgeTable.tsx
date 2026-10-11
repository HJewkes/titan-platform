import type { ReactNode } from "react";
import { DateTime, FilePathLabel, HStack, Link, Pill, Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow } from "@titan-design/react-ui";
import type { ConsoleCommands } from "../../server/commands.js";
import { refToRoute } from "../refs.js";
import { open } from "../router.js";

type KnowledgeRow = ConsoleCommands["work.notes"]["result"]["records"][number];

/** The Browse list: `Table` and `FilePathLabel` until react-ui has the knowledge list (TP-859). */
export function KnowledgeTable({ records }: { records: readonly KnowledgeRow[] }): ReactNode {
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
        <HStack gap={1}>
          <Pill variant="subtle" size="xs">
            {record.kind}
          </Pill>
          <Pill variant="subtle" size="xs">
            {record.type}
          </Pill>
        </HStack>
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
