import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { fetchTasks, markTaskDone, reorderTask, undoTaskDone } from '../utils/api.js';
import { restoreInPriorityOrder } from '../utils/task-order.js';
import type { TaskItem } from '../types.js';

interface PendingUndo {
  task: TaskItem;
}

type SetTasks = Dispatch<SetStateAction<TaskItem[] | null>>;
type SetErr = Dispatch<SetStateAction<string | null>>;

/** Groups tasks by initiative, preserving each group's first-seen (priority) order. */
export function groupBySlug(tasks: TaskItem[]): Array<{ slug: string; tasks: TaskItem[] }> {
  const order: string[] = [];
  const bySlug = new Map<string, TaskItem[]>();
  for (const task of tasks) {
    if (!bySlug.has(task.slug)) {
      order.push(task.slug);
      bySlug.set(task.slug, []);
    }
    bySlug.get(task.slug)!.push(task);
  }
  return order.map((slug) => ({ slug, tasks: bySlug.get(slug)! }));
}

export function useFetchedTasks(refreshToken: number): {
  tasks: TaskItem[] | null;
  setTasks: SetTasks;
  err: string | null;
  setErr: SetErr;
} {
  const [tasks, setTasks] = useState<TaskItem[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchTasks()
      .then((d) => {
        if (!cancelled) setTasks(d.tasks);
      })
      .catch((e: Error) => {
        if (!cancelled) setErr(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshToken]);

  return { tasks, setTasks, err, setErr };
}

export function useDoneActions(setTasks: SetTasks, setErr: SetErr) {
  const [pendingUndo, setPendingUndo] = useState<PendingUndo | null>(null);

  function handleMarkDone(task: TaskItem): void {
    setTasks((prev) => (prev ?? []).filter((t) => !(t.slug === task.slug && t.id === task.id)));
    setPendingUndo({ task });
    markTaskDone(task.slug, task.id).catch((e: Error) => setErr(e.message));
  }

  function handleUndo(): void {
    if (!pendingUndo) return;
    const { task } = pendingUndo;
    setPendingUndo(null);
    undoTaskDone(task.slug, task.id)
      .then(() => setTasks((prev) => restoreInPriorityOrder(prev ?? [], task)))
      .catch((e: Error) => setErr(e.message));
  }

  return { pendingUndo, setPendingUndo, handleMarkDone, handleUndo };
}

function moveBefore(prev: TaskItem[], dragged: TaskItem, target: TaskItem): TaskItem[] {
  const withoutDragged = prev.filter((t) => !(t.slug === dragged.slug && t.id === dragged.id));
  const targetIndex = withoutDragged.findIndex((t) => t.slug === target.slug && t.id === target.id);
  const next = [...withoutDragged];
  next.splice(targetIndex, 0, dragged);
  return next;
}

export function useDragReorder(setTasks: SetTasks, setErr: SetErr) {
  const [draggedId, setDraggedId] = useState<string | null>(null);

  function handleDrop(sectionTasks: TaskItem[], target: TaskItem): void {
    const dragged = sectionTasks.find((t) => t.id === draggedId);
    setDraggedId(null);
    if (!dragged || dragged.id === target.id) return;

    setTasks((prev) => (prev ? moveBefore(prev, dragged, target) : prev));
    reorderTask(dragged.slug, dragged.id, target.priority).catch((e: Error) => setErr(e.message));
  }

  return { draggedId, setDraggedId, handleDrop };
}
