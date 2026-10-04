/** A verdict block names its target when repo (GitHub ignores case), PR number and head sha all match. */
export function namesTarget(block: { repo: string; pr: number; head: string }, target: { repo: string; pr: number; head: string }): boolean {
  return block.repo.toLowerCase() === target.repo.toLowerCase() && block.pr === target.pr && block.head === target.head;
}
