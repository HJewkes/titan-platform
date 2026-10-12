import type { ReactNode } from "react";
import {
  Alert,
  Badge,
  BreadcrumbItem,
  Breadcrumbs,
  Card,
  CardContent,
  DataRow,
  DateTime,
  HStack,
  Link,
  Spinner,
  Typography,
  VStack,
} from "@titan-design/react-ui";
import { EXIT } from "@titan-design/registry";
import type { ConsoleCommands } from "../../server/commands.js";
import { useQuery } from "../data/rpc.js";
import { open } from "../router.js";
import { GuessedCaption, RefLink, TaskStageBadge } from "./TaskParts.js";

type Detail = ConsoleCommands["work.task"]["result"];
type Mention = Detail["mentions"][number];

/** One task from `work.task`: its record, pull request state, mentions and the sessions spawned for it. */
export function TaskDetailPage({ id }: { id: string }): ReactNode {
  const detail = useQuery("work.task", { id });
  if (detail.status === "loading") return <Spinner size="sm" label="Loading task" />;
  if (detail.data === undefined) {
    const message = detail.error.code === EXIT.NOINPUT ? `No task named ${id}` : `Could not load ${id}: ${detail.error.message}`;
    return (
      <VStack gap={4}>
        <Trail id={id} />
        <Alert status="error" message={message} />
      </VStack>
    );
  }
  return (
    <VStack gap={4}>
      <Trail id={id} />
      <Header task={detail.data.task} />
      <Panel title="Pull requests">
        <PullRequests detail={detail.data} />
      </Panel>
      <Panel title="Mentions">
        <Mentions mentions={detail.data.mentions} />
      </Panel>
      <Panel title="Linked sessions">
        <Sessions detail={detail.data} />
      </Panel>
    </VStack>
  );
}

function Trail({ id }: { id: string }): ReactNode {
  return (
    <Breadcrumbs>
      <BreadcrumbItem onPress={() => open({ view: "tasks" })}>Tasks</BreadcrumbItem>
      <BreadcrumbItem isCurrentPage>{id}</BreadcrumbItem>
    </Breadcrumbs>
  );
}

function Panel({ title, children }: { title?: string; children: ReactNode }): ReactNode {
  return (
    <Card>
      <CardContent>
        <VStack gap={3}>
          {title ? <Typography variant="h4">{title}</Typography> : null}
          {children}
        </VStack>
      </CardContent>
    </Card>
  );
}

function Header({ task }: { task: Detail["task"] }): ReactNode {
  return (
    <Panel>
      <HStack gap={3} align="center" wrap>
        <Typography variant="h3">{`${task.id} ${task.title}`}</Typography>
        <TaskStageBadge stage={task.stage} />
      </HStack>
      {task.stageGuessed ? <GuessedCaption /> : <Typography variant="caption" color="secondary">{task.stageReason}</Typography>}
      <DataRow label="Initiative" value={<Link color="primary" onPress={() => open({ view: "initiatives", id: task.slug })}>{task.slug}</Link>} />
      <DataRow label="Status" value={task.status} />
      <DataRow label="Severity" value={task.severity ?? "–"} />
      <DataRow label="Priority" value={String(task.priority)} />
      <DataRow label="Estimate" value={task.estimate !== undefined ? String(task.estimate) : "–"} />
      <DataRow label="Updated" value={task.updated} />
      {task.doneWhen ? <Field label="Done when" text={task.doneWhen} /> : null}
      {task.notes ? <Field label="Notes" text={task.notes} /> : null}
    </Panel>
  );
}

function Field({ label, text }: { label: string; text: string }): ReactNode {
  return (
    <VStack gap={1}>
      <Typography variant="subtitle2">{label}</Typography>
      <Typography variant="body1">{text}</Typography>
    </VStack>
  );
}

function PullRequests({ detail }: { detail: Detail }): ReactNode {
  const { openPrs, artifacts, evidence } = detail;
  const branches = artifacts.branches;
  return (
    <VStack gap={2}>
      {evidence.degraded.length > 0 ? <Alert status="warning" size="compact" message={`Pull request state is unavailable: ${evidence.degraded.join("; ")}.`} /> : null}
      {openPrs.length === 0 && branches.length === 0 ? <Typography variant="caption" color="secondary">No branch or pull request carries this task.</Typography> : null}
      {openPrs.map((pr) => (
        <HStack key={`${pr.repo}#${pr.number}`} gap={2} align="center" wrap>
          <RefLink refText={`pr:${pr.repo}#${pr.number}`} label={`${pr.repo}#${pr.number}`} />
          <Badge variant="subtle" size="sm" color="warning">open</Badge>
          <Typography variant="caption" color="secondary">{pr.headRef}</Typography>
        </HStack>
      ))}
      {branches.map((branch) => (
        <BranchRow key={`${branch.repo}/${branch.name}`} branch={branch} />
      ))}
    </VStack>
  );
}

function BranchRow({ branch }: { branch: Detail["artifacts"]["branches"][number] }): ReactNode {
  const { pr } = branch;
  return (
    <HStack gap={2} align="center" wrap>
      <Typography variant="mono">{`${branch.repo} ${branch.name}`}</Typography>
      {branch.present ? null : <Badge variant="outline" size="sm">branch gone</Badge>}
      {pr ? (
        <>
          <Link color="primary" isExternal onPress={() => window.open(pr.url, "_blank", "noopener")}>{`#${pr.number} ${pr.title}`}</Link>
          <Badge variant="subtle" size="sm">{pr.state.toLowerCase()}</Badge>
          {pr.checks ? <Typography variant="caption" color="secondary">{`checks ${pr.checks}`}</Typography> : null}
        </>
      ) : (
        <Typography variant="caption" color="secondary">no pull request</Typography>
      )}
    </HStack>
  );
}

const TASK_FILE = /^tasks\/(.+)\.yml$/;

/** A mention in another task's file names that task; session and artifact mentions have no page yet. */
function mentionRef(mention: Mention): string | undefined {
  const taskId = mention.source === "task" ? TASK_FILE.exec(mention.file)?.[1] : undefined;
  return taskId ? `task:${taskId}` : undefined;
}

function Mentions({ mentions }: { mentions: readonly Mention[] }): ReactNode {
  if (mentions.length === 0) return <Typography variant="caption" color="secondary">No record mentions this task.</Typography>;
  return (
    <VStack gap={2}>
      {mentions.map((mention) => {
        const ref = mentionRef(mention);
        return (
          <VStack key={`${mention.slug}/${mention.file}/${mention.field}`} gap={0}>
            {ref ? <RefLink refText={ref} label={`${mention.slug} ${ref.slice("task:".length)}`} /> : <Typography variant="mono">{`${mention.slug}/${mention.file}`}</Typography>}
            <Typography variant="caption" color="secondary">{`${mention.field}: ${mention.text}`}</Typography>
          </VStack>
        );
      })}
    </VStack>
  );
}

function Sessions({ detail }: { detail: Detail }): ReactNode {
  const { sessions, sessionsDegraded } = detail;
  if (sessionsDegraded) return <Alert status="warning" size="compact" message={`Session links are unavailable: ${sessionsDegraded.detail}`} />;
  if (sessions.length === 0) {
    return (
      <VStack gap={1}>
        <Typography variant="body1">No session names this task.</Typography>
        <Typography variant="caption" color="secondary">A session links to a task only when it was spawned with the task id.</Typography>
      </VStack>
    );
  }
  return (
    <VStack gap={2}>
      {sessions.map((session) => (
        <HStack key={session.sessionId} gap={2} align="center" wrap testID={`session-${session.sessionId}`}>
          <RefLink refText={`session:${session.sessionId}`} label={session.title ?? session.sessionId} />
          {session.agentName ? <RefLink refText={`agent:${session.agentName}`} label={session.agentName} /> : null}
          <DateTime value={session.startedAt} format="datetime" variant="caption" color="secondary" fallback="start unknown" />
        </HStack>
      ))}
    </VStack>
  );
}
