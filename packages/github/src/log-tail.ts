export function tail(log: string, lines: number): string {
  const all = log.split(/\r?\n/);
  if (all.at(-1) === "") all.pop();
  return all.slice(-lines).join("\n");
}
