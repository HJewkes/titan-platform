import type { Task } from '../schemas/task.js';

// A draft is an open task carrying this tag, not a new status: readers older than the draft
// feature parse status as open|done and would crash on any other value.
export const DRAFT_TAG = 'draft';

export const isDraft = (task: Pick<Task, 'tags'>): boolean => (task.tags ?? []).includes(DRAFT_TAG);
