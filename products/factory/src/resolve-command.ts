export function resolveCommand(runId: string, stepId: string): string {
  return `titan-factory gate resolve ${runId} ${stepId} --json '<payload>'`;
}
