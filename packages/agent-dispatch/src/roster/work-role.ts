const FIX_ROUND_SUFFIX = /(?:-s\d+)+$/
const SHEPHERD_REVIEW = /^rv-/

/** The role a spawner did not state, read from the agent's name first and its profile second. */
export function inferWorkRole(profile: string, name: string): string {
  const rounds = FIX_ROUND_SUFFIX.exec(name)?.[0].match(/-s\d+/g)?.length
  if (rounds !== undefined) return `fix-round-${rounds}`
  if (SHEPHERD_REVIEW.test(name) && profile.includes('reviewer')) return 'shepherd-review'
  if (profile.includes('reviewer') || /-review(?:-|$)/.test(name)) return 'reviewer'
  if (profile.includes('planner')) return 'planner'
  if (profile.includes('implementer')) return 'implementer'
  return 'other'
}
