import type { Progress } from '../types'

const MAX_COMMANDS = 8

export function emptyProgress(now: number): Progress {
  return {
    conversationId: null,
    activity: 'starting agy',
    files: [],
    commands: [],
    steps: 0,
    outcome: null,
    response: null,
    lastEventAt: now,
    runningCommand: null,
  }
}

function relative(path: string, root: string): string {
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path
}

function isWrite(tool: string): boolean {
  return /write|replace|edit|create|insert|delete|move|rename/i.test(tool) && !/^(view|read|list|grep|find|search)/i.test(tool)
}

type StepUpdate = {
  step_index?: number
  state?: string
  step_type?: string
  tool_name?: string
  tool_info?: { parameters?: Record<string, unknown> }
}

// Folds one line of `agy --output-format stream-json` into the run's progress.
export function applyLine(previous: Progress, line: string, root: string, now: number): Progress {
  let event: { event?: string; conversation_id?: string; step_update?: StepUpdate; result?: { status?: string; response?: string } }
  try {
    event = JSON.parse(line)
  } catch {
    return previous
  }
  const progress = { ...previous, lastEventAt: now }

  if (event.event === 'init') return { ...progress, conversationId: event.conversation_id ?? progress.conversationId }

  if (event.event === 'result') {
    const isSuccess = event.result?.status === 'SUCCESS'
    return {
      ...progress,
      outcome: isSuccess ? 'done' : 'failed',
      activity: isSuccess ? 'finished' : `ended: ${event.result?.status ?? 'unknown'}`,
      response: event.result?.response ?? null,
      runningCommand: null,
    }
  }

  const step = event.step_update
  if (event.event !== 'step_update' || !step) return progress

  const steps = Math.max(progress.steps, (step.step_index ?? 0) + 1)
  if (step.step_type === 'agent_response') return { ...progress, steps, activity: 'thinking', runningCommand: null }
  if (step.step_type !== 'tool' || !step.tool_name) return { ...progress, steps }

  const params = step.tool_info?.parameters ?? {}
  const target = [params.TargetFile, params.AbsolutePath, params.FilePath].find((p): p is string => typeof p === 'string')
  const command = typeof params.CommandLine === 'string' ? params.CommandLine : undefined
  const subject = command ?? (target ? relative(target, root) : '')

  let { files, commands, runningCommand } = progress
  if (step.state === 'DONE' && target && isWrite(step.tool_name)) {
    const file = relative(target, root)
    if (!files.includes(file)) files = [...files, file]
  }
  if (step.state === 'DONE' && command) commands = [...commands, command].slice(-MAX_COMMANDS)

  const index = step.step_index ?? -1
  if (command && step.state === 'ACTIVE') {
    if (runningCommand?.step !== index) runningCommand = { step: index, command, since: now }
  } else {
    runningCommand = null
  }

  return { ...progress, steps, files, commands, runningCommand, activity: `${step.tool_name} ${subject}`.trim() }
}

export function splitLines(partial: string, text: string): { lines: string[]; rest: string } {
  const pieces = (partial + text).split('\n')
  const rest = pieces.pop() ?? ''

  return { lines: pieces.filter(line => line.trim() !== ''), rest }
}
