// Style: camelCase vars/fns, PascalCase types, SCREAMING_SNAKE constants
// Formatting: no semicolons, single quotes
// Docs: JSDoc on exports only | Flow: early returns, guard clauses

const DEFAULT_SEPARATOR = '-'
const MAX_SLUG_LENGTH = 80

interface TruncateOptions {
  maxLength: number
  suffix?: string
}

/** Converts a string to a URL-friendly slug. */
export function toSlug(input: string): string {
  if (!input) {
    return ''
  }

  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, DEFAULT_SEPARATOR)
    .replace(/^-|-$/g, '')

  return slug.slice(0, MAX_SLUG_LENGTH)
}

/** Truncates a string to the specified length with an optional suffix. */
export function truncate(text: string, options: TruncateOptions): string {
  const suffix = options.suffix ?? '...'

  if (text.length <= options.maxLength) {
    return text
  }

  return text.slice(0, options.maxLength - suffix.length) + suffix
}

/** Capitalizes the first letter of each word. */
export function titleCase(input: string): string {
  if (!input) {
    return ''
  }

  return input
    .split(' ')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ')
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}
