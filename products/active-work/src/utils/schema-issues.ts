import type { ZodError } from 'zod';

/**
 * Render each zod issue as `<dotted path>: <message>`, joined by `; `.
 * An issue on the root value shows its path as `(root)`.
 */
export function formatIssues(error: ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.map(String).join('.') : '(root)'}: ${issue.message}`)
    .join('; ');
}
