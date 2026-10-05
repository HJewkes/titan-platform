/** A verdict block names its target when repo (GitHub ignores case), PR number and head sha all match. */
export function namesTarget(block: { repo: string; pr: number; head: string }, target: { repo: string; pr: number; head: string }): boolean {
  return block.repo.toLowerCase() === target.repo.toLowerCase() && block.pr === target.pr && block.head === target.head;
}

/** The same rule without the head: a block names the PR at any head. */
export function namesPr(block: { repo: string; pr: number }, target: { repo: string; pr: number }): boolean {
  return block.repo.toLowerCase() === target.repo.toLowerCase() && block.pr === target.pr;
}
