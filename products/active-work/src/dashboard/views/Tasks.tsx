import React, { useMemo } from 'react';
import { palette, sp, typography, severityColor } from '../tokens.js';
import { Card } from '../components/shared/Card.js';
import { DataTable, type DataTableColumn } from '../components/shared/DataTable.js';
import { StateBadge } from '../components/StateBadge.js';
import { Toast } from '../components/Toast.js';
import type { TaskItem, ViewProps } from '../types.js';
import { groupBySlug, useDoneActions, useDragReorder, useFetchedTasks } from './useTasksState.js';

const COLUMNS: DataTableColumn[] = [
  { key: 'id', label: 'ID', width: 90 },
  { key: 'title', label: 'Title', flex: 1 },
  { key: 'severity', label: 'Severity', width: 100 },
  { key: 'priority', label: 'Priority', width: 70 },
  { key: 'estimate', label: 'Estimate', width: 70 },
  { key: 'tags', label: 'Tags', width: 160 },
  { key: 'actions', label: '', width: 70 },
];

const monoCellStyle = { fontFamily: typography.mono, color: palette.textSecondary, fontSize: 13 };

function TagList({ tags }: { tags: string[] }): React.JSX.Element {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: sp[2] }}>
      {tags.map((tag) => (
        <span
          key={tag}
          style={{
            fontSize: 11,
            padding: `${sp[1]}px ${sp[4]}px`,
            borderRadius: 4,
            background: palette.surface3,
            color: palette.textSecondary,
          }}
        >
          {tag}
        </span>
      ))}
    </div>
  );
}

function DoneButton({ onClick }: { onClick: () => void }): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      style={{
        background: 'none',
        border: `1px solid ${palette.borderStrong}`,
        borderRadius: 4,
        color: palette.textSecondary,
        fontSize: 11,
        padding: `${sp[1]}px ${sp[4]}px`,
        cursor: 'pointer',
      }}
    >
      Done
    </button>
  );
}

function SeverityCell({ severity }: { severity: TaskItem['severity'] }): React.JSX.Element {
  return severity ? (
    <StateBadge label={severity} color={severityColor[severity]} />
  ) : (
    <span style={{ color: palette.textTertiary }}>—</span>
  );
}

function renderTaskCell(
  task: TaskItem,
  columnKey: string,
  onDone: (task: TaskItem) => void,
): React.ReactNode {
  switch (columnKey) {
    case 'id':
      return (
        <span style={{ fontFamily: typography.mono, fontSize: 12, color: palette.brand }}>
          {task.id}
        </span>
      );
    case 'title':
      return <span style={{ color: palette.textPrimary, fontSize: 13 }}>{task.title}</span>;
    case 'severity':
      return <SeverityCell severity={task.severity} />;
    case 'priority':
      return <span style={monoCellStyle}>p{task.priority}</span>;
    case 'estimate':
      return <span style={monoCellStyle}>{task.estimate ?? '—'}</span>;
    case 'tags':
      return <TagList tags={task.tags ?? []} />;
    case 'actions':
      return <DoneButton onClick={() => onDone(task)} />;
    default:
      return null;
  }
}

function ErrorBlock({ message }: { message: string }): React.JSX.Element {
  return (
    <div
      style={{
        background: `${palette.red}11`,
        border: `1px solid ${palette.red}55`,
        color: palette.red,
        padding: sp[8],
        borderRadius: 8,
        fontSize: 13,
      }}
    >
      Error: {message}
    </div>
  );
}

interface DraggableRowProps {
  task: TaskItem;
  dimmed: boolean;
  cells: React.ReactNode;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDrop: () => void;
}

function DraggableRow({
  task,
  dimmed,
  cells,
  onDragStart,
  onDragEnd,
  onDrop,
}: DraggableRowProps): React.JSX.Element {
  return (
    <div
      key={task.id}
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        onDrop();
      }}
      style={{ ...draggableRowStyle, opacity: dimmed ? 0.4 : 1 }}
    >
      {cells}
    </div>
  );
}

const draggableRowStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '90px 1fr 100px 70px 70px 160px 70px',
  alignItems: 'center',
  gap: sp[6],
  padding: `${sp[5]}px ${sp[6]}px`,
  borderRadius: 6,
  cursor: 'grab',
  background: palette.surface1,
};

interface InitiativeTasksProps {
  slug: string;
  tasks: TaskItem[];
  draggedId: string | null;
  setDraggedId: (id: string | null) => void;
  onDrop: (sectionTasks: TaskItem[], target: TaskItem) => void;
  onDone: (task: TaskItem) => void;
}

function InitiativeTasks({ slug, ...tableProps }: InitiativeTasksProps): React.JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: sp[4] }}>
      <h2 style={slugHeadingStyle}>{slug}</h2>
      <Card variant="plain" padding={sp[4]}>
        <TaskTable {...tableProps} />
      </Card>
    </div>
  );
}

function TaskTable({
  tasks,
  draggedId,
  setDraggedId,
  onDrop,
  onDone,
}: Omit<InitiativeTasksProps, 'slug'>): React.JSX.Element {
  return (
    <DataTable
      columns={COLUMNS}
      data={tasks}
      getKey={(task) => task.id}
      renderCell={(task, columnKey) => renderTaskCell(task, columnKey, onDone)}
      renderRow={(task, cells) => (
        <DraggableRow
          task={task}
          dimmed={draggedId === task.id}
          cells={cells}
          onDragStart={() => setDraggedId(task.id)}
          onDragEnd={() => setDraggedId(null)}
          onDrop={() => onDrop(tasks, task)}
        />
      )}
    />
  );
}

const slugHeadingStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 13,
  fontFamily: typography.mono,
  color: palette.textSecondary,
  textTransform: 'uppercase',
  letterSpacing: 0.5,
};

function TasksHeader({
  taskCount,
  sectionCount,
}: {
  taskCount: number;
  sectionCount: number;
}): React.JSX.Element {
  return (
    <>
      <h1 style={{ margin: 0, fontSize: 22, color: palette.textPrimary }}>Open tasks</h1>
      <p style={{ margin: 0, fontSize: 12, color: palette.textTertiary }}>
        {taskCount} open task(s) across {sectionCount} initiative(s). Drag a row to reorder within
        its initiative; use Done to complete a task.
      </p>
    </>
  );
}

interface TaskSectionsProps extends Omit<InitiativeTasksProps, 'slug' | 'tasks'> {
  sections: Array<{ slug: string; tasks: TaskItem[] }>;
}

function TaskSections({ sections, ...rowProps }: TaskSectionsProps): React.JSX.Element {
  if (sections.length === 0) return <EmptyTasks />;
  return (
    <>
      {sections.map(({ slug, tasks }) => (
        <InitiativeTasks key={slug} slug={slug} tasks={tasks} {...rowProps} />
      ))}
    </>
  );
}

export function TasksView({ refreshToken }: ViewProps): React.JSX.Element {
  const { tasks, setTasks, err, setErr } = useFetchedTasks(refreshToken);
  const { draggedId, setDraggedId, handleDrop } = useDragReorder(setTasks, setErr);
  const done = useDoneActions(setTasks, setErr);
  const sections = useMemo(() => groupBySlug(tasks ?? []), [tasks]);

  if (err) return <ErrorBlock message={err} />;
  if (!tasks) return <div style={{ color: palette.textTertiary, fontSize: 13 }}>Loading…</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: sp[10] }}>
      <TasksHeader taskCount={tasks.length} sectionCount={sections.length} />
      <TaskSections
        sections={sections}
        draggedId={draggedId}
        setDraggedId={setDraggedId}
        onDrop={handleDrop}
        onDone={done.handleMarkDone}
      />
      {done.pendingUndo && (
        <UndoToast
          task={done.pendingUndo.task}
          onUndo={done.handleUndo}
          onDismiss={() => done.setPendingUndo(null)}
        />
      )}
    </div>
  );
}

interface UndoToastProps {
  task: TaskItem;
  onUndo: () => void;
  onDismiss: () => void;
}

function UndoToast({ task, onUndo, onDismiss }: UndoToastProps): React.JSX.Element {
  return (
    <Toast
      message={`Marked ${task.id} done`}
      actionLabel="Undo"
      onAction={onUndo}
      onDismiss={onDismiss}
    />
  );
}

function EmptyTasks(): React.JSX.Element {
  return (
    <p style={{ margin: 0, color: palette.textTertiary, fontSize: 13 }}>
      No open tasks. Inbox zero, nice.
    </p>
  );
}
