import type { ReactNode } from "react";
import { Alert, EmptyState, Section, SectionContent, SectionHeader, Spinner, Typography, VStack } from "@titan-design/react-ui";
import type { ConsoleCommands } from "../../server/commands.js";
import { useQuery } from "../data/rpc.js";
import { ConfigRowCard, DuplicateCard, type ConfigRow, type DuplicateRow } from "./ConfigRows.js";

type Surfaces = ConsoleCommands["config.surfaces"]["result"];
type ConfigFile = Surfaces["files"][number];

const GROUP_TITLES: Record<ConfigFile["group"], string> = {
  coordinator: "Coordinator",
  "agent-chat": "agent-chat",
  factory: "Factory",
  console: "Console",
  claude: "Claude Code",
};

interface SurfaceBlock {
  surface: string;
  file: ConfigFile | undefined;
  rows: ConfigRow[];
}

/** Surfaces in the order the files were read, within the catalog's group order; a row whose file is unlisted still shows, under Other. */
function groupSurfaces({ files, rows }: Pick<Surfaces, "files" | "rows">): { title: string; surfaces: SurfaceBlock[] }[] {
  const fileOf = new Map(files.map((file) => [file.surface, file]));
  const surfaces = [...new Set([...files.map((file) => file.surface), ...rows.map((row) => row.surface)])];
  const blocks = surfaces.map((surface) => ({ surface, file: fileOf.get(surface), rows: rows.filter((row) => row.surface === surface) }));
  const titleOf = (block: SurfaceBlock): string => (block.file === undefined ? "Other" : GROUP_TITLES[block.file.group]);
  const titles = [...Object.values(GROUP_TITLES), "Other"];
  return titles.map((title) => ({ title, surfaces: blocks.filter((block) => titleOf(block) === title) })).filter((group) => group.surfaces.length > 0);
}

/** Every config row this host's console reads, drift first. Read-only: a terminal row shows the command that edits its line. */
export function ConfigPage(): ReactNode {
  const surfaces = useQuery("config.surfaces");
  const drift = useQuery("config.drift");
  return (
    <VStack gap={6} className="px-inset-md">
      {drift.status === "loading" ? (
        <Spinner size="sm" label="Loading drift" />
      ) : drift.data === undefined ? (
        <Alert status="error" message={`Could not load config drift: ${drift.error.message}`} />
      ) : (
        <DriftSections rows={drift.data.rows} />
      )}
      {surfaces.status === "loading" ? (
        <Spinner size="sm" label="Loading config" />
      ) : surfaces.data === undefined ? (
        <Alert status="error" message={`Could not load config: ${surfaces.error.message}`} />
      ) : (
        <SurfaceSections surfaces={surfaces.data} />
      )}
    </VStack>
  );
}

function DriftSections({ rows }: { rows: readonly DuplicateRow[] }): ReactNode {
  const drifted = rows.filter((row) => row.status === "drift");
  const agreed = rows.filter((row) => row.status === "agree");
  return (
    <>
      <Section testID="config-drift">
        <SectionHeader title={`Drift (${drifted.length})`} subtitle="One value kept in several files, whose copies disagree" />
        <SectionContent>{drifted.length === 0 ? <EmptyState title="No copies disagree" /> : <Cards rows={drifted} />}</SectionContent>
      </Section>
      {agreed.length > 0 ? (
        <Section testID="config-agree">
          <SectionHeader title={`Kept in step (${agreed.length})`} subtitle="Copies that agree today; change them together" />
          <SectionContent>
            <Cards rows={agreed} />
          </SectionContent>
        </Section>
      ) : null}
    </>
  );
}

function Cards({ rows }: { rows: readonly DuplicateRow[] }): ReactNode {
  return (
    <VStack gap={3}>
      {rows.map((row) => (
        <DuplicateCard key={row.id} row={row} />
      ))}
    </VStack>
  );
}

function SurfaceSections({ surfaces }: { surfaces: Surfaces }): ReactNode {
  const groups = groupSurfaces(surfaces);
  return (
    <>
      {groups.length === 0 ? <EmptyState title="No config file was read" /> : null}
      {groups.map((group) => (
        <Section key={group.title} testID={`config-group-${group.title}`}>
          <SectionHeader title={group.title} />
          <SectionContent>
            <VStack gap={4}>
              {group.surfaces.map((block) => (
                <SurfaceList key={block.surface} block={block} />
              ))}
            </VStack>
          </SectionContent>
        </Section>
      ))}
      {surfaces.gaps.length > 0 ? <GapsSection gaps={surfaces.gaps} /> : null}
    </>
  );
}

function SurfaceList({ block }: { block: SurfaceBlock }): ReactNode {
  const { file } = block;
  const backup = file?.newestBackup ? `, newest backup ${file.newestBackup}` : "";
  return (
    <VStack gap={2} testID={`config-surface-${block.surface}`}>
      <Typography variant="subtitle1">{block.surface}</Typography>
      {file !== undefined ? <Typography variant="caption" color="secondary" className="break-all">{`${file.file}, changed ${file.mtime}${backup}`}</Typography> : null}
      {block.rows.length === 0 ? <Typography variant="caption" color="secondary">No rows</Typography> : null}
      {block.rows.map((row) => (
        <ConfigRowCard key={`${row.field}:${row.line}`} row={row} />
      ))}
    </VStack>
  );
}

/** A file the read could not reach, so its rows are missing rather than absent. */
function GapsSection({ gaps }: { gaps: readonly string[] }): ReactNode {
  return (
    <Section testID="config-gaps">
      <SectionHeader title={`Not read (${gaps.length})`} />
      <SectionContent>
        <VStack gap={1}>
          {gaps.map((gap) => (
            <Typography key={gap} variant="caption" color="secondary" className="break-all">{gap}</Typography>
          ))}
        </VStack>
      </SectionContent>
    </Section>
  );
}
