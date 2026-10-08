import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { applyLine, emptyProgress, splitLines } from '../hooks/agy'
import { foldSession, planTarget, sourceName } from '../hooks/jules'
import type { JulesJob, Run } from '../types'

// The test runner has timers; the hooks module's type environment does not declare them.
declare const setTimeout: (fn: () => void, ms: number) => unknown

// Trimmed from a real `agy -p --output-format stream-json` run.
const AGY_RUN = [
  '{"event":"init","conversation_id":"66c40316","init":{"cwd":"/repo"}}',
  '{"event":"step_update","step_update":{"step_index":2,"state":"ACTIVE","step_type":"tool","tool_name":"write_to_file","tool_info":{"name":"write_to_file","parameters":{"TargetFile":"/repo/hello.txt"}}}}',
  '{"event":"step_update","step_update":{"step_index":2,"state":"DONE","step_type":"tool","tool_name":"write_to_file","tool_info":{"name":"write_to_file","parameters":{"TargetFile":"/repo/hello.txt"}}}}',
  '{"event":"step_update","step_update":{"step_index":3,"state":"DONE","step_type":"tool","tool_name":"view_file","tool_info":{"name":"view_file","parameters":{"AbsolutePath":"/repo/README.md"}}}}',
  '{"event":"step_update","step_update":{"step_index":4,"state":"ACTIVE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"cat hello.txt"}}}}',
  '{"event":"step_update","step_update":{"step_index":4,"state":"DONE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"cat hello.txt"},"output":"hi\\r\\n"}}}',
  '{"event":"step_update","step_update":{"step_index":5,"state":"DONE","step_type":"agent_response","text_delta":"\\n"}}',
  '{"event":"result","result":{"status":"SUCCESS","response":"Created hello.txt. Deviation: none."}}',
]

describe('agy stream', () => {
  test('folds a run into files, commands and the final message', async () => {
    const progress = AGY_RUN.reduce((p, line) => applyLine(p, line, '/repo', 0), emptyProgress(0))
    expect(progress.conversationId).toBe('66c40316')
    expect(progress.files).toEqual(['hello.txt'])
    expect(progress.commands).toEqual(['cat hello.txt'])
    expect(progress.steps).toBe(6)
    expect(progress.outcome).toBe('done')
    expect(progress.response).toBe('Created hello.txt. Deviation: none.')
  })

  test('shows the active tool as the activity', async () => {
    const progress = AGY_RUN.slice(0, 5).reduce((p, line) => applyLine(p, line, '/repo', 0), emptyProgress(0))
    expect(progress.activity).toBe('run_command cat hello.txt')
  })

  test('a failed result and junk lines', async () => {
    const failed = applyLine(applyLine(emptyProgress(0), 'not json', '/repo', 0), '{"event":"result","result":{"status":"ERROR"}}', '/repo', 0)
    expect(failed.outcome).toBe('failed')
  })

  test('tracks when agy last spoke and which command is still running', async () => {
    const [active, done] = [AGY_RUN[4]!, AGY_RUN[5]!]
    let progress = applyLine(emptyProgress(0), active, '/repo', 1_000)
    expect(progress.runningCommand).toEqual({ step: 4, command: 'cat hello.txt', since: 1_000 })

    progress = applyLine(progress, active, '/repo', 5_000)
    expect(progress.runningCommand?.since).toBe(1_000)
    expect(progress.lastEventAt).toBe(5_000)
    expect(applyLine(progress, 'not json', '/repo', 9_000).lastEventAt).toBe(5_000)
    expect(applyLine(progress, done, '/repo', 6_000).runningCommand).toBeNull()
  })

  test('splits chunks across line boundaries', async () => {
    const first = splitLines('', '{"a":1}\n{"b"')
    expect(first.lines).toEqual(['{"a":1}'])
    expect(splitLines(first.rest, ':2}\n').lines).toEqual(['{"b":2}'])
  })
})

const ROOT = '/repo'
const PLAN = `${ROOT}/plans/nfl-pickem.md`

function ran(exitCode: number, stdout = '') {
  return { value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
}

type Fake = {
  ahead?: number
  planMarkdown?: string
  // agy's stdout lines; the whole of AGY_RUN when not given.
  agyLines?: string[]
  // Keeps the stream open after the last line, as a server agy started would.
  isStdoutHeld?: boolean
  isAgyAlive?: () => boolean
  runs?: string[]
  toasts?: string[]
}

function fakeSession(on: On, submitted: string[], logged: Record<string, unknown>[] = [], repo: Fake = {}) {
  const clock = mock.clock(on)
  mock.env(on, { HOME: '/home/me' })
  on('tool.register', async (_$, e) => ({ value: { tool: e.name } }))
  on('fs.read', async () => ({ value: repo.planMarkdown ?? '# plan' }) as never)
  on('session.id', async () => ({ value: 'sess-1' }))
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('session.cwd', async () => ({ value: ROOT }))
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', async () => ({ value: { isOpen: true } }) as never)
  on('ui.toast', async (_$, e) => {
    repo.toasts?.push(String((e as { text?: unknown }).text ?? e))
    return { value: undefined }
  })
  on('prompt.submit', async (_$, e) => {
    submitted.push(e.text)
    return { text: e.text } as never
  })
  on('process.run', async (_$, e) => {
    const args = e.argv.join(' ')
    if (e.argv.at(-1)!.endsWith('/mod-logs/handoff.jsonl')) {
      logged.push(JSON.parse(e.init?.stdin ?? '{}'))
      return ran(0)
    }
    repo.runs?.push(args)
    if (args === 'ps -o stat= -p 777') return (repo.isAgyAlive?.() ?? true) ? ran(0, 'S\n') : ran(1)
    if (args === 'git rev-parse --show-toplevel') return ran(0, `${ROOT}\n`)
    if (args === 'git rev-parse HEAD') return ran(0, 'abc123def4567890\n')
    if (args.startsWith('git status --porcelain')) return ran(0, ' M src/already-dirty.ts\n')
    if (args === 'git rev-parse --abbrev-ref HEAD') return ran(0, 'main\n')
    if (args === 'git remote get-url origin') return ran(0, 'git@github.com:dd/app.git\n')
    if (args === 'git rev-list --count origin/main..HEAD') return ran(0, `${repo.ahead ?? 0}\n`)
    if (args === 'security find-generic-password -s jules-api -w') return ran(0, 'key-1\n')
    return ran(0)
  })
  on('process.spawn', async function* (_$, e) {
    expect(e.argv).toContain('agy')
    expect(e.argv.join(' ')).toContain('Implement @plans/nfl-pickem.md exactly as written')
    expect(e.env).toMatchObject({ CI: '1' })
    yield { stream: 'stdout' as const, text: '__AGYPID 777\n' }
    yield { stream: 'stdout' as const, text: (repo.agyLines ?? AGY_RUN).join('\n') + '\n' }
    if (repo.isStdoutHeld) await new Promise<void>(() => {})
    return { value: { code: 0, signal: null } }
  })
  on('tool.call', { tool: 'Write' }, async () => ({ result: { type: 'create' as const, filePath: PLAN, content: '', structuredPatch: [], originalFile: null } }) as never)
  on('tool.call', { tool: 'Edit' }, async () => ({ result: { filePath: PLAN, oldString: 'a', newString: 'b', structuredPatch: [] } }) as never)

  return clock
}

const BAND = {
  plugin: 'handoff',
  component: 'AbovePrompt' as const,
  props: { hasSurvey: false } as never,
}

describe('engine', () => {
  test('a plan written to plans/ offers the handoff, and a headless run ends in a review', async ($, on) => {
    const submitted: string[] = []
    const logged: Record<string, unknown>[] = []
    fakeSession(on, submitted, logged)
    await $.session.start({ cwd: ROOT, surface: null, isInteractive: true })

    await $.tool.call({ tool: 'Write', file_path: PLAN, content: '# plan' })

    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await band.find({ type: 'Text', text: 'plans/nfl-pickem.md' })).toBeDefined()
    await band.press({ key: 'headless' })

    for (let i = 0; i < 50 && submitted.length === 0; i++) await new Promise<void>(resolve => setTimeout(resolve, 10))
    expect(submitted.length).toBe(1)
    expect(submitted[0]).toContain('plan-diff-review')
    expect(submitted[0]).toContain('git diff abc123def4567890')
    expect(submitted[0]).toContain('src/already-dirty.ts')
    expect(submitted[0]).toContain('Deviation: none.')
    expect(logged.map(l => l.event)).toEqual(['plan', 'run-start', 'run-end', 'review'])
    expect(logged[2]).toMatchObject({ outcome: 'done', files: 1, commands: 1 })
    await band.unmount()
  })

  test('agy exiting while a process it started holds stdout open still ends the run', async ($, on) => {
    const submitted: string[] = []
    const runs: string[] = []
    let isAgyAlive = true
    const clock = fakeSession(on, submitted, [], { isStdoutHeld: true, isAgyAlive: () => isAgyAlive, runs })
    await $.session.start({ cwd: ROOT, surface: null, isInteractive: true })
    await $.tool.call({ tool: 'Write', file_path: PLAN, content: '# plan' })
    await $.command.run({ command: 'handoff', args: 'headless' } as never)
    await clock.settle()

    await clock.advance(15_000)
    expect(submitted).toEqual([])
    isAgyAlive = false
    await clock.advance(15_000)
    expect(runs).toContain('kill -TERM -- -777')

    await clock.advance(10_000)
    expect(runs).toContain('kill -KILL -- -777')
    expect(submitted.length).toBe(1)
    expect(submitted[0]).toContain('Deviation: none.')
  })

  test('a run with no output for 20 minutes is warned about, stopped, and reviewed as stalled', async ($, on) => {
    const submitted: string[] = []
    const logged: Record<string, unknown>[] = []
    const runs: string[] = []
    const toasts: string[] = []
    const clock = fakeSession(on, submitted, logged, { agyLines: AGY_RUN.slice(0, 5), isStdoutHeld: true, runs, toasts })
    await $.session.start({ cwd: ROOT, surface: null, isInteractive: true })
    await $.tool.call({ tool: 'Write', file_path: PLAN, content: '# plan' })
    await $.command.run({ command: 'handoff', args: 'headless' } as never)
    await clock.settle()

    await clock.advance(10 * 60_000)
    expect(toasts.some(t => t.includes('quiet for 10m00s while running cat hello.txt'))).toBe(true)
    expect(runs.some(r => r.startsWith('kill'))).toBe(false)

    await clock.advance(10 * 60_000)
    expect(runs).toContain('kill -TERM -- -777')
    await clock.advance(10_000)
    expect(submitted.length).toBe(1)
    expect(submitted[0]).toContain('stopped after 20 minutes with no output while running `cat hello.txt`')
    expect(logged.find(l => l.event === 'run-end')).toMatchObject({ outcome: 'stalled' })
  })

  test('a headless run a reload left behind is marked lost, and Stop still kills its group', async ($, on) => {
    const runs: string[] = []
    const logged: Record<string, unknown>[] = []
    const clock = fakeSession(on, [], logged, { runs })
    // The session state as a reload leaves it: a run still marked running, and no module variable holding its process.
    const orphan: Run = { mode: 'headless', startedAt: 0, progress: emptyProgress(0), changedFiles: 0, pid: 777 }
    on('state.get', async (_$, e, next) => {
      const read = (await next(e)) as { value: { value?: unknown; version: number } }
      const isRun = (e as { key?: string }).key === 'run'
      return isRun && read.value.value == null ? ({ value: { ...read.value, value: orphan } } as never) : (read as never)
    })
    await $.session.start({ cwd: ROOT, surface: null, isInteractive: true })
    await clock.settle()
    expect(logged.find(l => l.event === 'run-end')).toMatchObject({ outcome: 'lost', isRunning: true })

    const result = await $.command.run({ command: 'handoff', args: 'stop' } as never)
    expect(result.text).toBe('Stopped what agy left running.')
    expect(runs).toContain('kill -TERM -- -777')
  })

  test('writes to plans/*.md skip the permission dialog, and nothing else does', async ($, on) => {
    fakeSession(on, [])
    on('tool.check', async (_$, e) => {
      const path = (e.input as { file_path: string }).file_path
      return { decision: path.endsWith('denied.md') ? ('deny' as const) : ('ask' as const) }
    })
    await $.session.start({ cwd: ROOT, surface: null, isInteractive: true })
    const check = (tool: string, file_path: string) => $.tool.check({ tool, input: { file_path, content: '' } } as never)

    expect((await check('Write', `${ROOT}/plans/new-plan.md`)).decision).toBe('allow')
    expect((await check('Edit', `${ROOT}/plans/new-plan.md`)).decision).toBe('allow')
    expect((await check('Write', `${ROOT}/plans/sub/x.md`)).decision).toBe('ask')
    expect((await check('Write', `${ROOT}/plans/../src/a.md`)).decision).toBe('ask')
    expect((await check('Write', `${ROOT}/src/a.md`)).decision).toBe('ask')
    expect((await check('Write', `${ROOT}/plans/denied.md`)).decision).toBe('deny')
  })

  test('a plan copied in by the shell is picked up on its first Edit, and later edits keep its state', async ($, on) => {
    const logged: Record<string, unknown>[] = []
    fakeSession(on, [], logged)
    await $.session.start({ cwd: ROOT, surface: null, isInteractive: true })

    const edit = { tool: 'Edit', file_path: PLAN, old_string: 'a', new_string: 'b' } as never
    await $.tool.call(edit)
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await band.find({ type: 'Text', text: 'plans/nfl-pickem.md' })).toBeDefined()

    await $.tool.call(edit)
    await new Promise<void>(resolve => setTimeout(resolve, 10))
    expect(logged.filter(l => l.event === 'plan').length).toBe(1)
    await band.unmount()
  })

  test('a plan file outside the repo plans/ dir is ignored', async ($, on) => {
    fakeSession(on, [])
    await $.session.start({ cwd: ROOT, surface: null, isInteractive: true })
    await $.tool.call({ tool: 'Write', file_path: '/Users/me/.claude/plans/some-plan.md', content: '# plan' })

    await expect($.ui.mount({ ...BAND, surface: 'terminal' })).rejects.toThrow()
  })
})

const JOB: JulesJob = {
  session: 'sessions/42',
  url: 'https://jules.google.com/session/42',
  title: 'nfl-pickem',
  prompt: 'do it',
  branch: 'main',
  plan: null,
  startedAt: 0,
  state: 'QUEUED',
  activity: 'starting',
  prUrl: null,
  response: null,
  isReviewed: false,
}

describe('jules helpers', () => {
  test('source names from GitHub remotes', async () => {
    expect(sourceName('git@github.com:dd/app.git\n')).toBe('sources/github/dd/app')
    expect(sourceName('https://github.com/dd/app')).toBe('sources/github/dd/app')
    expect(sourceName('ssh://git@github.com/dd/my.app.git')).toBe('sources/github/dd/my.app')
    expect(sourceName('git@gitlab.com:dd/app.git')).toBeUndefined()
  })

  test('reads the plan target line', async () => {
    expect(planTarget('# Title\n\nTarget: jules — test backfill\n')).toBe('jules')
    expect(planTarget('**Target:** agy (needs the simulator)')).toBe('agy')
    expect(planTarget('# Title\n\nThe target audience is claude users')).toBeNull()
  })

  test('folds a running session into its latest activity', async () => {
    const job = foldSession(JOB, { state: 'IN_PROGRESS' }, [
      { createTime: '2026-10-07T10:02:00Z', progressUpdated: { title: 'Running tests' } },
      { createTime: '2026-10-07T10:00:00Z', planGenerated: { plan: { steps: [1, 2, 3] } } },
    ])
    expect(job.state).toBe('IN_PROGRESS')
    expect(job.activity).toBe('Running tests')
    expect(job.prUrl).toBeNull()
  })

  test('folds a completed session with its PR and a failed one with its reason', async () => {
    const done = foldSession(JOB, { state: 'COMPLETED', outputs: [{ pullRequest: { url: 'https://github.com/dd/app/pull/7' } }] }, [
      { createTime: '1', agentMessaged: { agentMessage: 'Added tests. No deviations.' } },
      { createTime: '2', sessionCompleted: {} },
    ])
    expect(done.prUrl).toBe('https://github.com/dd/app/pull/7')
    expect(done.response).toBe('Added tests. No deviations.')
    expect(done.activity).toBe('completed')

    const failed = foldSession(JOB, { state: 'FAILED' }, [{ createTime: '1', sessionFailed: { reason: 'build broke' } }])
    expect(failed.activity).toBe('failed: build broke')
  })
})

type Fetch = { url: string; method: string; body: Record<string, unknown> | null }

function fakeJules(on: On, fetches: Fetch[]) {
  let polls = 0
  on('http.fetch', async (_$, e) => {
    const method = e.init?.method ?? 'GET'
    fetches.push({ url: e.url, method, body: e.init?.body ? JSON.parse(e.init.body) : null })
    const reply = (body: unknown) => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } })
    if (method === 'POST') return reply({ name: 'sessions/42', id: '42', state: 'QUEUED' })
    if (e.url.includes('/activities')) {
      return reply({ activities: [{ createTime: '1', agentMessaged: { agentMessage: 'Added the tests.' } }] })
    }
    polls++
    return polls < 2
      ? reply({ state: 'IN_PROGRESS' })
      : reply({ state: 'COMPLETED', outputs: [{ pullRequest: { url: 'https://github.com/dd/app/pull/7' } }] })
  })
}

describe('jules engine', () => {
  test('a jules-target plan goes to Jules from origin and its PR is reviewed when done', async ($, on) => {
    const submitted: string[] = []
    const logged: Record<string, unknown>[] = []
    const fetches: Fetch[] = []
    const clock = fakeSession(on, submitted, logged, { planMarkdown: '# NFL\n\nTarget: jules — isolated\n\nStep one.' })
    fakeJules(on, fetches)
    await $.session.start({ cwd: ROOT, surface: null, isInteractive: true })

    await $.tool.call({ tool: 'Write', file_path: PLAN, content: '# plan' })
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await band.press({ key: 'jules' })

    expect(fetches[0]!.method).toBe('POST')
    expect(fetches[0]!.body).toMatchObject({
      title: 'nfl-pickem',
      automationMode: 'AUTO_CREATE_PR',
      sourceContext: { source: 'sources/github/dd/app', githubRepoContext: { startingBranch: 'main' } },
    })
    expect(String(fetches[0]!.body!.prompt)).toContain('Step one.')

    await clock.advance(60_000)
    expect(submitted).toEqual([])
    await clock.advance(60_000)

    expect(submitted.length).toBe(1)
    expect(submitted[0]).toContain('plan-diff-review')
    expect(submitted[0]).toContain('gh pr diff https://github.com/dd/app/pull/7')
    expect(submitted[0]).toContain('Added the tests.')
    expect(logged.map(l => l.event)).toEqual(['plan', 'run-start', 'run-end', 'review'])
    expect(logged[2]).toMatchObject({ mode: 'jules', outcome: 'done', hasPr: true })
    await band.unmount()
  })

  test('unpushed commits stop the handoff before any API call', async ($, on) => {
    const fetches: Fetch[] = []
    fakeSession(on, [], [], { ahead: 2 })
    fakeJules(on, fetches)
    await $.session.start({ cwd: ROOT, surface: null, isInteractive: true })
    await $.tool.call({ tool: 'Write', file_path: PLAN, content: '# plan' })

    const result = await $.command.run({ command: 'handoff', args: 'jules' } as never)
    expect(result.text).toContain("2 commits on main aren't pushed")
    expect(fetches).toEqual([])
  })

  test('jules_delegate starts an ad-hoc session without a plan', async ($, on) => {
    const fetches: Fetch[] = []
    fakeSession(on, [])
    fakeJules(on, fetches)
    await $.session.start({ cwd: ROOT, surface: null, isInteractive: true })

    const result = await $.tool.call({ tool: 'mcp__handoff__jules_delegate', title: 'Backfill tests', prompt: 'Add tests for src/a.ts' } as never)
    expect(typeof result.result).toBe('string')
    expect(String(result.result)).toContain('https://jules.google.com/session/42')
    expect(fetches[0]!.body).toMatchObject({ title: 'Backfill tests', prompt: 'Add tests for src/a.ts' })
  })
})
