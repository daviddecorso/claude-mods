import type { JulesJob, Target } from '../types'

export const JULES_API = 'https://jules.googleapis.com/v1alpha'

const FINISHED = new Set(['COMPLETED', 'FAILED'])

export type JulesSession = {
  name?: string
  id?: string
  url?: string
  state?: string
  outputs?: { pullRequest?: { url?: string } }[]
}

export type JulesActivity = {
  createTime?: string
  description?: string
  planGenerated?: { plan?: { steps?: unknown[] } }
  progressUpdated?: { title?: string; description?: string }
  agentMessaged?: { agentMessage?: string }
  sessionCompleted?: Record<string, unknown>
  sessionFailed?: { reason?: string }
}

// `sources/github/<owner>/<repo>` for a GitHub remote in https, scp-style or ssh:// form.
export function sourceName(remote: string): string | undefined {
  const match = remote.trim().match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/)
  return match ? `sources/github/${match[1]}/${match[2]}` : undefined
}

export function planTarget(markdown: string): Target | null {
  const match = markdown.match(/^\**Target:?\**:?\s*`?(jules|agy|claude)\b/im)
  return match ? (match[1]!.toLowerCase() as Target) : null
}

export function isFinished(state: string): boolean {
  return FINISHED.has(state)
}

function activityText(activity: JulesActivity): string | undefined {
  if (activity.sessionFailed) return `failed: ${activity.sessionFailed.reason ?? 'no reason given'}`
  if (activity.sessionCompleted) return 'completed'
  if (activity.progressUpdated) return activity.progressUpdated.title ?? activity.progressUpdated.description
  if (activity.agentMessaged?.agentMessage) return activity.agentMessaged.agentMessage
  if (activity.planGenerated) return `planned ${activity.planGenerated.plan?.steps?.length ?? 0} steps`
  return activity.description
}

// Folds one poll of the session and its activities into the job; the API is v1alpha, so every field is optional.
export function foldSession(job: JulesJob, session: JulesSession, activities: readonly JulesActivity[]): JulesJob {
  const ordered = [...activities].sort((a, b) => (a.createTime ?? '').localeCompare(b.createTime ?? ''))
  const latest = ordered.map(activityText).filter((text): text is string => Boolean(text)).at(-1)
  const lastMessage = ordered.map(a => a.agentMessaged?.agentMessage).filter((text): text is string => Boolean(text)).at(-1)
  const prUrl = session.outputs?.map(output => output.pullRequest?.url).find(Boolean) ?? job.prUrl

  return {
    ...job,
    state: session.state ?? job.state,
    url: session.url ?? job.url,
    activity: firstLine(latest ?? job.activity),
    prUrl,
    response: lastMessage ?? job.response,
  }
}

function firstLine(text: string): string {
  return text.split('\n').find(line => line.trim() !== '')?.trim() ?? text
}

export function sessionUrl(session: JulesSession): string {
  return session.url ?? `https://jules.google.com/session/${session.id ?? session.name?.split('/').pop() ?? ''}`
}

export function julesPlanPrompt(path: string, plan: string): string {
  return [
    `Implement the plan below (from ${path} in this repo) exactly as written.`,
    "If you must deviate, do the minimum and list every deviation in the PR description. Don't refactor anything the plan doesn't mention.",
    '',
    plan,
  ].join('\n')
}

export function julesReviewPrompt(job: JulesJob): string {
  const parts = job.plan
    ? [`Use the handoff:plan-diff-review skill to review what Jules implemented against ${job.plan.path}.`]
    : [`Review what Jules implemented for this task:\n\n${job.prompt}`]
  parts.push(
    job.prUrl
      ? `The diff is Jules's PR ${job.prUrl}: \`gh pr diff ${job.prUrl}\`. It branched from origin/${job.branch}, so local uncommitted work isn't in it.`
      : `Jules opened no PR; its session is ${job.url}.`,
  )
  if (job.response) parts.push(`Jules's last message:\n\n${job.response.trim()}`)
  if (job.state === 'FAILED') parts.push('Jules did not finish successfully; say what is missing.')

  return parts.join('\n\n')
}

export function apiError(status: number, text: string): string {
  try {
    const message = (JSON.parse(text) as { error?: { message?: string } }).error?.message
    if (message) return `${status}: ${message}`
  } catch {
    // Not JSON; fall through to the raw body.
  }
  return `${status}: ${text.slice(0, 200)}`
}
