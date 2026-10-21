import type { ReactNode } from "react";
import { MarkdownProse, Typography, VStack } from "@titan-design/react-ui";
import type { Manifest } from "../../server/round-schema.js";

type PrGroup = NonNullable<Manifest["prGroups"]>[number];

const NOT_RECORDED = "not recorded";

/** The PR as its group describes it, read-only (the harness's Context tab); a field the round leaves out reads "not recorded". */
export function ShipContext({ pr, group }: { pr: string; group: PrGroup | undefined }): ReactNode {
  const task = group?.task;
  return (
    <VStack gap={4} testID={`context-${pr}`}>
      <ContextPart label="Description" testID="context-description">
        <Prose body={group?.description} testID={`description-${pr}`} />
      </ContextPart>
      <ContextPart label={task ? `Task ${task.id}${task.title ? `: ${task.title}` : ""}, done when` : "Task done when"} testID="context-task">
        <Prose body={task?.doneWhen} testID={`done-when-${pr}`} />
      </ContextPart>
      <ContextPart label="Codewatch report" testID="context-codewatch">
        <Prose body={group?.codewatch} testID={`codewatch-${pr}`} />
      </ContextPart>
      <ContextPart label={group?.files ? `Files changed (${group.files.length})` : "Files changed"} testID="context-files">
        <Files files={group?.files} />
      </ContextPart>
    </VStack>
  );
}

function ContextPart({ label, testID, children }: { label: string; testID: string; children: ReactNode }): ReactNode {
  return (
    <VStack gap={1} testID={testID}>
      <Typography variant="microLabel" color="secondary">{label.toUpperCase()}</Typography>
      {children}
    </VStack>
  );
}

function Prose({ body, testID }: { body: string | undefined; testID: string }): ReactNode {
  return body ? <MarkdownProse body={body} testID={testID} /> : <Typography variant="body2" color="secondary">{NOT_RECORDED}</Typography>;
}

function Files({ files }: { files: PrGroup["files"] }): ReactNode {
  if (files === undefined || files.length === 0) return <Typography variant="body2" color="secondary">{NOT_RECORDED}</Typography>;
  return (
    <ul className="flex flex-col gap-1">
      {files.map((file) => (
        <li key={file.path}>
          <Typography variant="body2"><code>{file.path}</code>{file.status ? ` ${file.status}` : ""}</Typography>
        </li>
      ))}
    </ul>
  );
}
