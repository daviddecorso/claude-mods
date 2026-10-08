export type Target = 'jules' | 'agy' | 'claude'

export type Plan = {
  slug: string
  // Relative to root, e.g. plans/nfl-pickem.md.
  path: string
  root: string
  baseRev: string
  dirtyAtStart: string[]
  // From the plan's `Target:` line; null when it has none.
  target: Target | null
}

export type Progress = {
  conversationId: string | null
  activity: string
  files: string[]
  commands: string[]
  steps: number
  // stalled: the watchdog stopped agy after too long with no output. lost: a reload dropped the process handle mid-run.
  outcome: 'done' | 'failed' | 'stopped' | 'stalled' | 'lost' | null
  response: string | null
  // Milliseconds since the epoch, like every timestamp here.
  lastEventAt: number | null
  // A run_command step agy has started and not finished.
  runningCommand: { step: number; command: string; since: number } | null
}

export type Run = {
  mode: 'headless' | 'interactive'
  startedAt: number
  progress: Progress
  changedFiles: number
  // agy's pid, which is also its process group; kept here so a reload can still stop what it left running.
  pid: number | null
}

export type JulesJob = {
  // API resource name, `sessions/<id>`.
  session: string
  url: string
  title: string
  prompt: string
  branch: string
  // Null for ad-hoc jobs from the jules_delegate tool.
  plan: Plan | null
  // Milliseconds since the epoch.
  startedAt: number
  // The API's session state, e.g. IN_PROGRESS, AWAITING_USER_FEEDBACK, COMPLETED, FAILED.
  state: string
  activity: string
  prUrl: string | null
  response: string | null
  isReviewed: boolean
}

declare module 'claude-code' {
  interface PluginState {
    handoff: {
      plan: Plan | null
      run: Run | null
      isBandHidden: boolean
      julesJobs: JulesJob[]
    }
  }
}
