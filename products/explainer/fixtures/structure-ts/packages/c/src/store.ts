const rows: string[] = [];

export function save(value: string): string {
  rows.push(value);
  return `saved ${rows.length}`;
}

export function count(): number {
  return rows.length;
}
