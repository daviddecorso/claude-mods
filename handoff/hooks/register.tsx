import { atom, read, update } from 'claude-code'
import type { EngineInterface, HookStream, ProcessSpawnChunk, ProcessSpawnResult, Register, Timer } from 'claude-code'

import type { JulesJob, Plan, Progress, Run } from '../types'
import { applyLine, emptyProgress, splitLines } from './agy'
import type { JulesActivity, JulesSession } from './jules'
import {
  JULES_API,
  apiError,
  foldSession,
  isFinished,
  julesPlanPrompt,
  julesReviewPrompt,
  planTarget,
  sessionUrl,
  sourceName,
} from './jules'

type $ = EngineInterface

type Agent = {
  stream: HookStream<ProcessSpawnChunk, ProcessSpawnResult>
  pid?: number
  // Set before the group is killed; wins over whatever outcome agy reported.
  endReason?: 'stopped' | 'stalled'
  hasExited: boolean
  isStallWarned: boolean
  watchdog?: Timer
  abandon: () => void
}

const PANE = 'handoff'
const JULES_PANE = 'jules'
const PID_MARK = '__AGYPID '
const POLL_MS = 15_000
const WATCH_MS = 15_000
const KILL_GRACE_MS = 5_000
const QUIET_SHOW_MS = 60_000
const QUIET_WARN_MS = 10 * 60_000
const QUIET_STOP_MS = 20 * 60_000
const JULES_POLL_MS = 60_000
const MAX_ACTIVITY_PAGES = 5
const KEY_HELP = 'No Jules API key. Store one with: security add-generic-password -s jules-api -a "$USER" -w'

const JULES_TOOL_DESCRIPTION = [
  "Hands a self-contained coding task to Jules, Google's async cloud agent, which works from a pushed GitHub branch and opens a PR against it. Returns the session URL; the user sees progress in the /handoff jules-status pane.",
  'Use only for jules-shaped work: self-contained, verifiable by tests/CI or a diff small enough to read in one pass, no local-only state (simulators, local DB, secrets, dev server), no design or product judgment.',
  'Good fits: test backfill, dependency bumps, isolated bugs, lint/type cleanups, docs, mechanical migrations. Never for work that depends on uncommitted changes or on context from this conversation that the prompt does not spell out.',
  'Write the prompt self-contained: name the files, the expected behaviour and how to verify it. Jules sees only the pushed branch and the prompt.',
].join(' ')

const plan = atom({ plugin: 'handoff', key: 'plan' } as const, null as Plan | null)
const run = atom({ plugin: 'handoff', key: 'run' } as const, null as Run | null)
const isBandHidden = atom({ plugin: 'handoff', key: 'isBandHidden' } as const, false)
const julesJobs = atom({ plugin: 'handoff', key: 'julesJobs' } as const, [] as JulesJob[])

// The live agy process and the polls belong to this module: a hot reload stops them, and session.start resumes the Jules poll.
let agent: Agent | undefined
let poll: Timer | undefined
let julesPoll: Timer | undefined
let isJulesPolling = false
let julesKey: string | undefined

// Appends one line to ~/.claude/mod-logs/handoff.jsonl, which /mods-report reads; never fails the hook.
async function logEvent($: $, event: Record<string, unknown>) {
  try {
    const home = await $.env.get('HOME')
    const line = JSON.stringify({ at: new Date().toISOString(), session: await $.session.id(), ...event })
    await $.process.run(
      ['/bin/sh', '-c', 'mkdir -p "$(dirname "$1")" && cat >> "$1"', 'sh', `${home}/.claude/mod-logs/handoff.jsonl`],
      { stdin: `${line}\n` },
    )
  } catch {
    // Logging is best effort.
  }
}

function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`
}

function quietNote(progress: Progress, now: number): string {
  if (progress.outcome !== null || progress.lastEventAt === null) return ''
  const quiet = now - progress.lastEventAt
  return quiet >= QUIET_SHOW_MS ? ` · quiet ${duration(quiet)}` : ''
}

function agyPrompt(path: string): string {
  return [
    `Implement @${path} exactly as written. If you must deviate, do the minimum and list every deviation in your final message. Don't refactor anything the plan doesn't mention.`,
    "If a command runs longer than 5 minutes, stop it, don't retry it, and list it as a deviation.",
  ].join(' ')
}

function reviewPrompt(target: Plan, current: Run | null): string {
  const parts = [
    `Use the handoff:plan-diff-review skill to review what agy implemented against ${target.path}.`,
    `The diff is everything since ${target.baseRev.slice(0, 12)}: \`git diff ${target.baseRev}\` plus untracked files from \`git status\`.`,
  ]
  if (target.dirtyAtStart.length > 0) {
    parts.push(`These files already had uncommitted changes before the handoff, so not all of their diff is agy's: ${target.dirtyAtStart.join(', ')}.`)
  }
  if (current?.progress.response) parts.push(`agy's final message:\n\n${current.progress.response.trim()}`)
  if (current?.progress.outcome === 'failed') parts.push('agy did not finish successfully; say what is missing.')
  if (current?.progress.outcome === 'stalled') {
    const command = current.progress.runningCommand?.command
    const doing = command ? ` while running \`${command}\`` : ''
    parts.push(`agy was stopped after ${QUIET_STOP_MS / 60_000} minutes with no output${doing}; treat whatever that step verifies as unverified, and say what is missing.`)
  }
  if (current?.progress.outcome === 'lost') parts.push('The session lost track of agy mid-run, so it may not have finished; say what is missing.')

  return parts.join('\n\n')
}

async function git($: $, root: string, ...args: string[]) {
  return $.process.run(['git', ...args], { cwd: root })
}

async function repoRoot($: $, dir: string): Promise<string | undefined> {
  const top = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd: dir })
  return top.exitCode === 0 ? top.stdout.trim() : undefined
}

async function capturePlan($: $, absolute: string): Promise<Plan | undefined> {
  const dir = absolute.slice(0, absolute.lastIndexOf('/'))
  const root = await repoRoot($, dir)
  if (!root || dir !== `${root}/plans`) return undefined

  const head = await git($, root, 'rev-parse', 'HEAD')
  const status = await git($, root, 'status', '--porcelain', '--', '.', ':!plans')
  const markdown = await $.fs.read(absolute).catch(() => '')
  const captured: Plan = {
    slug: absolute.slice(dir.length + 1, -'.md'.length),
    path: absolute.slice(root.length + 1),
    root,
    baseRev: head.stdout.trim(),
    dirtyAtStart: status.stdout.split('\n').filter(Boolean).map(line => line.slice(3)),
    target: planTarget(markdown),
  }
  await update($, plan, () => captured)
  await update($, run, () => null)
  await update($, isBandHidden, () => false)
  void logEvent($, { event: 'plan', slug: captured.slug, root, dirtyAtStart: captured.dirtyAtStart.length, target: captured.target })

  return captured
}

async function findPlan($: $, query: string): Promise<string> {
  const root = await repoRoot($, await $.session.cwd())
  if (!root) return 'Not inside a git repo.'
  const entries = await $.fs.list(`${root}/plans`).catch(() => [])
  const plans = entries.filter(entry => entry.kind === 'file' && entry.name.endsWith('.md'))
  const matches = plans.filter(entry => entry.name.includes(query))
  if (matches.length === 0) return `No plan in plans/ matching "${query}".`
  if (matches.length > 1) return `Several plans match: ${matches.map(m => m.name).join(', ')}`

  const captured = await capturePlan($, `${root}/plans/${matches[0]!.name}`)
  return captured ? `Plan ready: ${captured.path}. Pick how to hand it off above the prompt.` : 'Could not read that plan.'
}

async function setProgress($: $, change: (progress: Progress) => Progress) {
  await update($, run, current => (current ? { ...current, progress: change(current.progress) } : current))
}

async function isAlive($: $, pid: number): Promise<boolean> {
  const ps = await $.process.run(['ps', '-o', 'stat=', '-p', String(pid)])
  const stat = ps.stdout.trim()
  return ps.exitCode === 0 && stat !== '' && !stat.startsWith('Z')
}

async function killGroup($: $, pgid: number) {
  await $.process.run(['kill', '-TERM', '--', `-${pgid}`])
  $.clock.after(KILL_GRACE_MS, () => void $.process.run(['kill', '-KILL', '--', `-${pgid}`]))
}

async function endAgent($: $, current: Agent) {
  if (current.pid === undefined) {
    void current.stream.return(undefined as never)
    current.abandon()
    return
  }
  await killGroup($, current.pid)
  // A process that left the group or survives KILL would hold the stream open forever.
  $.clock.after(KILL_GRACE_MS * 2, () => current.abandon())
}

async function watchAgent($: $, current: Agent) {
  if (agent !== current || current.endReason || current.hasExited) return
  await $.ui.invalidate('ui.render')

  if (current.pid !== undefined && !(await isAlive($, current.pid))) {
    // agy exited, but anything it left running (a dev server, a test runner) holds its stdout open.
    current.hasExited = true
    await endAgent($, current)
    return
  }

  const progress = (await read($, run))?.progress
  if (!progress || progress.outcome !== null || progress.lastEventAt === null) return
  const quiet = (await $.clock.now()) - progress.lastEventAt
  const doing = progress.runningCommand ? ` while running ${progress.runningCommand.command}` : ''
  if (quiet >= QUIET_STOP_MS) {
    current.endReason = 'stalled'
    await setProgress($, p => ({ ...p, activity: `stalled: no output for ${duration(quiet)}${doing}` }))
    await endAgent($, current)
  } else if (quiet >= QUIET_WARN_MS && !current.isStallWarned) {
    current.isStallWarned = true
    $.ui.toast(`agy has been quiet for ${duration(quiet)}${doing}; it is stopped at ${QUIET_STOP_MS / 60_000}m`)
  }
}

async function pumpAgent($: $, current: Agent, target: Plan) {
  let partial = ''
  let ended: ProcessSpawnResult | undefined
  const abandoned = new Promise<'abandoned'>(resolve => {
    current.abandon = () => resolve('abandoned')
  })
  try {
    while (true) {
      const step = await Promise.race([current.stream.next(), abandoned])
      if (step === 'abandoned') break
      if (step.done) {
        ended = step.value
        break
      }
      if (step.value.stream !== 'stdout') continue
      const { lines, rest } = splitLines(partial, step.value.text)
      partial = rest
      for (const line of lines) {
        if (line.startsWith(PID_MARK)) {
          const pid = Number(line.slice(PID_MARK.length))
          current.pid = pid
          await update($, run, r => (r ? { ...r, pid } : r))
          continue
        }
        const now = await $.clock.now()
        current.isStallWarned = false
        await setProgress($, progress => applyLine(progress, line, target.root, now))
      }
    }
  } catch (error) {
    await setProgress($, progress => ({ ...progress, activity: `agy failed to run: ${String(error)}` }))
  }

  current.watchdog?.cancel()
  agent = undefined
  await setProgress($, progress => ({
    ...progress,
    outcome: current.endReason ?? progress.outcome ?? (ended?.code === 0 ? 'done' : 'failed'),
  }))
  const finished = await read($, run)
  const outcome = finished?.progress.outcome
  void logEvent($, {
    event: 'run-end',
    mode: 'headless',
    slug: target.slug,
    outcome,
    durationMs: finished ? (await $.clock.now()) - finished.startedAt : null,
    files: finished?.progress.files.length ?? 0,
    steps: finished?.progress.steps ?? 0,
    commands: finished?.progress.commands.length ?? 0,
    exitCode: ended?.code ?? null,
  })
  $.ui.toast(`agy ${outcome === 'done' ? 'finished' : outcome}: ${finished?.progress.files.length ?? 0} files changed`)
  if (outcome !== 'stopped') {
    void logEvent($, { event: 'review', slug: target.slug, trigger: 'auto' })
    await $.prompt.submit({ text: reviewPrompt(target, finished) })
  }
}

async function runHeadless($: $): Promise<string> {
  const target = await read($, plan)
  if (!target) return 'No plan to hand off. Run /handoff first.'
  if (agent) return 'agy is already running.'

  // setpgrp puts agy at the head of its own process group, so killing the group reaches the servers and test runners it starts.
  const stream = $.process.spawn({
    argv: [
      '/usr/bin/perl', '-e', `$| = 1; setpgrp(0, 0); print "${PID_MARK}$$\\n"; exec @ARGV or die "exec: $!\\n"`,
      'agy', '-p', agyPrompt(target.path), '--add-dir', target.root, '--mode', 'accept-edits', '--output-format', 'stream-json',
    ],
    cwd: target.root,
    env: { CI: '1' },
  })
  const current: Agent = { stream, hasExited: false, isStallWarned: false, abandon: () => {} }
  agent = current
  void logEvent($, { event: 'run-start', mode: 'headless', slug: target.slug })
  const now = await $.clock.now()
  await update($, run, (): Run => ({ mode: 'headless', startedAt: now, progress: emptyProgress(now), changedFiles: 0, pid: null }))
  current.watchdog = $.clock.every(WATCH_MS, () => void watchAgent($, current))
  void pumpAgent($, current, target)
  await $.ui.open({ id: PANE, title: `agy · ${target.slug}` })

  return `agy is implementing ${target.path} headless; the review starts when it exits.`
}

async function stopAgent($: $): Promise<string> {
  if (agent) {
    agent.endReason = 'stopped'
    await endAgent($, agent)
    return 'Stopping agy.'
  }

  const current = await read($, run)
  if (current?.progress.outcome !== 'lost' || current.pid === null) return 'agy is not running.'
  await killGroup($, current.pid)
  await setProgress($, progress => ({ ...progress, outcome: 'stopped', activity: 'stopped what agy left running' }))
  return 'Stopped what agy left running.'
}

// A reload drops the module's process handle; a headless run still marked running is no longer tracked.
async function markLost($: $) {
  const current = await read($, run)
  if (agent || current?.mode !== 'headless' || current.progress.outcome !== null) return

  const isRunning = current.pid !== null && (await isAlive($, current.pid))
  await setProgress($, progress => ({
    ...progress,
    outcome: 'lost',
    activity: isRunning ? `the mod reloaded; agy (pid ${current.pid}) still runs untracked` : 'the mod reloaded mid-run; agy is gone',
  }))
  void logEvent($, { event: 'run-end', mode: 'headless', outcome: 'lost', isRunning })
}

async function countChanged($: $, target: Plan) {
  const status = await git($, target.root, 'status', '--porcelain', '--', '.', ':!plans')
  const committed = await git($, target.root, 'diff', '--name-only', target.baseRev, 'HEAD')
  const files = new Set([
    ...status.stdout.split('\n').filter(Boolean).map(line => line.slice(3)),
    ...committed.stdout.split('\n').filter(Boolean),
  ])
  await update($, run, current => (current ? { ...current, changedFiles: files.size } : current))
  $.ui.status(`agy -i: ${files.size} files changed since handoff`)
}

async function handOffInteractive($: $, surface?: Parameters<$['ui']['copy']>[0]['surface']): Promise<string> {
  const target = await read($, plan)
  if (!target) return 'No plan to hand off. Run /handoff first.'

  const command = `handoff ${target.slug}`
  const copied = await $.ui.copy({ text: command, surface })
  void logEvent($, { event: 'run-start', mode: 'interactive', slug: target.slug })
  const now = await $.clock.now()
  await update($, run, (): Run => ({ mode: 'interactive', startedAt: now, progress: emptyProgress(now), changedFiles: 0, pid: null }))
  poll?.cancel()
  poll = $.clock.every(POLL_MS, () => void countChanged($, target))
  await countChanged($, target)

  return copied.isCopied
    ? `Copied \`${command}\`. Run it in another terminal; /handoff review when agy is done.`
    : `Run \`${command}\` in another terminal; /handoff review when agy is done.`
}

async function review($: $): Promise<string> {
  const target = await read($, plan)
  if (!target) return 'No plan has been handed off.'
  poll?.cancel()
  poll = undefined
  $.ui.status(undefined)
  const current = await read($, run)
  await update($, isBandHidden, () => true)
  if (current?.mode === 'interactive') {
    void logEvent($, {
      event: 'run-end',
      mode: 'interactive',
      slug: target.slug,
      outcome: 'reviewed',
      durationMs: (await $.clock.now()) - current.startedAt,
      files: current.changedFiles,
    })
  }
  void logEvent($, { event: 'review', slug: target.slug, trigger: 'manual' })
  await $.prompt.submit({ text: reviewPrompt(target, current) })

  return `Reviewing against ${target.path}.`
}

async function dismiss($: $) {
  await update($, isBandHidden, () => true)
}

async function apiKey($: $): Promise<string | undefined> {
  if (julesKey) return julesKey
  const stored = await $.process.run(['security', 'find-generic-password', '-s', 'jules-api', '-w'])
  const key = stored.exitCode === 0 ? stored.stdout.trim() : await $.env.get('JULES_API_KEY')
  julesKey = key || undefined
  return julesKey
}

async function julesFetch<T>($: $, path: string, body?: unknown): Promise<T> {
  const key = await apiKey($)
  if (!key) throw new Error(KEY_HELP)
  const response = await $.http.fetch(`${JULES_API}/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'X-Goog-Api-Key': key, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`Jules API ${apiError(response.status, response.text)}`)
  return JSON.parse(response.text || '{}') as T
}

// Returns the GitHub source for `branch` once it's on origin with nothing unpushed, or why it can't be used.
async function pushedBranch($: $, root: string, requested?: string): Promise<{ source: string; branch: string } | string> {
  const current = (await git($, root, 'rev-parse', '--abbrev-ref', 'HEAD')).stdout.trim()
  const branch = requested?.trim() || current
  if (!branch || branch === 'HEAD') return 'Detached HEAD: check out a branch first.'

  const source = sourceName((await git($, root, 'remote', 'get-url', 'origin')).stdout)
  if (!source) return "origin isn't a GitHub remote, so Jules can't reach this repo."

  const onOrigin = await git($, root, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`)
  if (onOrigin.exitCode !== 0) return `${branch} isn't on origin yet. Push it first: git push -u origin ${branch}`

  if (branch === current) {
    const ahead = Number((await git($, root, 'rev-list', '--count', `origin/${branch}..HEAD`)).stdout.trim())
    if (ahead > 0) return `${ahead} commit${ahead === 1 ? '' : 's'} on ${branch} aren't pushed, and Jules only sees origin. Push first: git push`
  }

  return { source, branch }
}

async function startJules(
  $: $,
  task: { title: string; prompt: string; root: string; branch?: string; plan: Plan | null },
): Promise<JulesJob | string> {
  const pushed = await pushedBranch($, task.root, task.branch)
  if (typeof pushed === 'string') return pushed

  const session = await julesFetch<JulesSession>($, 'sessions', {
    title: task.title,
    prompt: task.prompt,
    sourceContext: { source: pushed.source, githubRepoContext: { startingBranch: pushed.branch } },
    automationMode: 'AUTO_CREATE_PR',
    requirePlanApproval: false,
  })
  const job: JulesJob = {
    session: session.name ?? `sessions/${session.id}`,
    url: sessionUrl(session),
    title: task.title,
    prompt: task.prompt,
    branch: pushed.branch,
    plan: task.plan,
    startedAt: Date.now(),
    state: session.state ?? 'QUEUED',
    activity: 'starting',
    prUrl: null,
    response: null,
    isReviewed: false,
  }
  await update($, julesJobs, jobs => [...jobs, job])
  void logEvent($, { event: 'run-start', mode: 'jules', slug: task.plan?.slug ?? null, title: task.title, branch: pushed.branch })
  await ensureJulesPoll($)

  return job
}

async function sendPlanToJules($: $): Promise<string> {
  const target = await read($, plan)
  if (!target) return 'No plan to hand off. Run /handoff first.'

  try {
    const markdown = await $.fs.read(`${target.root}/${target.path}`)
    const started = await startJules($, {
      title: target.slug,
      prompt: julesPlanPrompt(target.path, markdown),
      root: target.root,
      plan: target,
    })
    if (typeof started === 'string') return started

    await update($, isBandHidden, () => true)
    const dirty = target.dirtyAtStart.length
    const note = dirty > 0 ? ` ${dirty} uncommitted file${dirty === 1 ? '' : 's'} aren't part of what Jules sees.` : ''
    return `Jules is implementing ${target.path} from origin/${started.branch}: ${started.url}. The review starts when its PR lands.${note}`
  } catch (error) {
    return (error as Error).message
  }
}

async function updateJob($: $, session: string, change: (job: JulesJob) => JulesJob) {
  await update($, julesJobs, jobs => jobs.map(job => (job.session === session ? change(job) : job)))
}

async function fetchActivities($: $, session: string): Promise<JulesActivity[]> {
  const activities: JulesActivity[] = []
  let pageToken = ''
  for (let page = 0; page < MAX_ACTIVITY_PAGES; page++) {
    const query = `pageSize=100${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`
    const result = await julesFetch<{ activities?: JulesActivity[]; nextPageToken?: string }>($, `${session}/activities?${query}`)
    activities.push(...(result.activities ?? []))
    if (!result.nextPageToken) break
    pageToken = result.nextPageToken
  }
  return activities
}

async function pollJules($: $) {
  if (isJulesPolling) return
  isJulesPolling = true
  try {
    for (const job of await read($, julesJobs)) {
      if (isFinished(job.state)) continue
      try {
        const session = await julesFetch<JulesSession>($, job.session)
        const activities = await fetchActivities($, job.session)
        const next = foldSession(job, session, activities)
        await updateJob($, job.session, () => next)
        if (isFinished(next.state)) await finishJules($, next)
      } catch (error) {
        await updateJob($, job.session, current => ({ ...current, activity: `poll failed: ${(error as Error).message}` }))
      }
    }
  } finally {
    isJulesPolling = false
  }
  await ensureJulesPoll($)
}

async function ensureJulesPoll($: $) {
  const isActive = (await read($, julesJobs)).some(job => !isFinished(job.state))
  if (isActive && !julesPoll) julesPoll = $.clock.every(JULES_POLL_MS, () => void pollJules($))
  if (!isActive && julesPoll) {
    julesPoll.cancel()
    julesPoll = undefined
  }
}

async function finishJules($: $, job: JulesJob) {
  void logEvent($, {
    event: 'run-end',
    mode: 'jules',
    slug: job.plan?.slug ?? null,
    title: job.title,
    outcome: job.state === 'COMPLETED' ? 'done' : 'failed',
    durationMs: Date.now() - job.startedAt,
    hasPr: job.prUrl !== null,
  })
  const pr = job.prUrl ? `: ${job.prUrl}` : ', no PR'
  $.ui.toast(`Jules ${job.state === 'COMPLETED' ? 'finished' : 'failed'} ${job.title}${pr}`)
  if (job.plan && job.prUrl) await reviewJules($, job.session, 'auto')
}

async function reviewJules($: $, session: string, trigger: 'auto' | 'manual'): Promise<string> {
  const job = (await read($, julesJobs)).find(j => j.session === session)
  if (!job) return 'That Jules job is no longer tracked.'
  await updateJob($, session, current => ({ ...current, isReviewed: true }))
  void logEvent($, { event: 'review', mode: 'jules', slug: job.plan?.slug ?? null, title: job.title, trigger })
  await $.prompt.submit({ text: julesReviewPrompt(job) })

  return `Reviewing Jules's ${job.title}.`
}

async function forgetJules($: $, session: string) {
  await update($, julesJobs, jobs => jobs.filter(job => job.session !== session))
  await ensureJulesPoll($)
}

async function openJulesPane($: $) {
  await $.ui.open({ id: JULES_PANE, title: 'jules' })
  void pollJules($)
}

async function delegate($: $, input: Record<string, unknown>): Promise<string> {
  const title = String(input.title ?? '').trim()
  const prompt = String(input.prompt ?? '').trim()
  if (!title || !prompt) throw new Error('title and prompt are both required')
  const root = await repoRoot($, await $.session.cwd())
  if (!root) throw new Error('not inside a git repo')

  const branch = typeof input.branch === 'string' ? input.branch : undefined
  const started = await startJules($, { title, prompt, root, branch, plan: null })
  if (typeof started === 'string') throw new Error(started)

  return `Jules session started on origin/${started.branch}: ${started.url}. It opens a PR when done; the user tracks it in /handoff jules-status.`
}

async function isPlanFile($: $, input: unknown): Promise<boolean> {
  const path = (input as { file_path?: unknown } | null)?.file_path
  if (typeof path !== 'string') return false
  const root = await repoRoot($, await $.session.cwd())
  if (!root || !path.startsWith(`${root}/plans/`)) return false
  const name = path.slice(`${root}/plans/`.length)
  return /^[^/]+\.md$/.test(name) && !name.includes('..')
}

function toolText(body: string, isError = false) {
  return isError ? { result: body, isError: true as const } : { result: body }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'handoff',
      description: 'Hand the plan to agy or Jules: no args writes it with /handoff:plan-handoff; <slug>, review, stop, jules, jules-status',
      argumentHint: '[<plan slug> | review | stop | jules | jules-status]',
    })
    await $.tool.register({
      name: 'jules_delegate',
      description: JULES_TOOL_DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short title for the Jules session and its PR.' },
          prompt: { type: 'string', description: 'The full, self-contained task.' },
          branch: { type: 'string', description: 'Pushed branch to start from; defaults to the current branch.' },
        },
        required: ['title', 'prompt'],
      },
    })
    await ensureJulesPoll($)
    await markLost($)
    return started
  })

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const result = await next(e)
    if (result.deny === undefined && result.isError !== true && /\/plans\/[^/]+\.md$/.test(e.file_path)) {
      await capturePlan($, e.file_path)
    }
    return result
  }).catch(($, e, next) => next(e))

  // A plan copied in through the shell first shows up as an Edit; editing the plan already captured must not reset its run.
  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const result = await next(e)
    if (result.deny === undefined && result.isError !== true && /\/plans\/[^/]+\.md$/.test(e.file_path)) {
      const current = await read($, plan)
      if (!current || `${current.root}/${current.path}` !== e.file_path) await capturePlan($, e.file_path)
    }
    return result
  }).catch(($, e, next) => next(e))

  for (const tool of ['Write', 'Edit']) {
    on('tool.check', { tool }, async ($, e, next) => {
      const verdict = await next(e)
      if (verdict.decision === 'deny' || !(await isPlanFile($, e.input))) return verdict
      return { decision: 'allow' as const, reason: 'handoff: plan file in the repo plans/ dir' }
    }).catch(($, e, next) => next(e))
  }

  on('tool.call', { tool: 'mcp__handoff__jules_delegate' }, async ($, e) => {
    try {
      return toolText(await delegate($, e))
    } catch (error) {
      return toolText(`jules_delegate failed: ${(error as Error).message}`, true)
    }
  }).catch(() => toolText('jules_delegate failed', true))

  on('command.run', { command: 'handoff' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'review') return { text: await review($) }
    if (arg === 'stop') return { text: await stopAgent($) }
    if (arg === 'headless') return { text: await runHeadless($) }
    if (arg === 'copy') return { text: await handOffInteractive($) }
    if (arg === 'jules') return { text: await sendPlanToJules($) }
    if (arg === 'jules-status') {
      await openJulesPane($)
      return { text: `${(await read($, julesJobs)).length} Jules jobs tracked.` }
    }
    if (arg !== '') return { text: await findPlan($, arg) }

    await $.prompt.submit({ text: '/handoff:plan-handoff' })
    return { text: 'Writing the plan with /handoff:plan-handoff; pick how to hand it off when it lands.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const target = await read($, plan)
    const current = await read($, run)
    const jobs = await read($, julesJobs)
    const now = await $.clock.now()

    let planRow = null
    if (target && !(await read($, isBandHidden))) {
      if (!current) {
        const suggested = target.target ?? 'agy'
        planRow = (
          <Box>
            <Text>Plan ready: </Text>
            <Text bold>{target.path} </Text>
            {target.target === 'claude' ? <Text dimColor>(targets claude) </Text> : null}
            <Button key="headless" label="Run headless" variant={suggested === 'agy' ? 'primary' : undefined} onPress={() => void runHeadless($)} />
            <Button key="copy" label="Copy for agy -i" onPress={press => void handOffInteractive($, press.surface)} />
            <Button
              key="jules"
              label="Send to Jules"
              variant={suggested === 'jules' ? 'primary' : undefined}
              onPress={() => void sendPlanToJules($).then(text => $.ui.toast(text))}
            />
            <Button key="dismiss" label="×" plain onPress={() => dismiss($)} />
          </Box>
        )
      } else if (current.mode === 'interactive') {
        planRow = (
          <Box>
            <Text dimColor>agy -i on {target.slug}: {current.changedFiles} files changed · {duration(now - current.startedAt)} </Text>
            <Button key="review" label="Review now" variant="primary" onPress={() => void review($)} />
            <Button key="dismiss" label="×" plain onPress={() => dismiss($)} />
          </Box>
        )
      } else {
        const { progress } = current
        const isRunning = progress.outcome === null
        const isStoppable = isRunning || (progress.outcome === 'lost' && current.pid !== null)
        planRow = (
          <Box>
            <Text color={isRunning ? 'warning' : progress.outcome === 'done' ? 'success' : 'error'}>
              agy {isRunning ? 'running' : progress.outcome}{' '}
            </Text>
            <Text dimColor wrap="truncate-end">
              {target.slug} · {progress.files.length} files · {duration(now - current.startedAt)} · {progress.activity}
              {quietNote(progress, now)}{' '}
            </Text>
            <Button key="open" label="Details" onPress={() => void $.ui.open({ id: PANE, title: `agy · ${target.slug}` })} />
            {isStoppable ? (
              <Button key="stop" label="Stop" onPress={() => void stopAgent($)} />
            ) : (
              <Button key="dismiss" label="×" plain onPress={() => dismiss($)} />
            )}
          </Box>
        )
      }
    }

    let julesRow = null
    if (jobs.length > 0) {
      const running = jobs.filter(job => !isFinished(job.state)).length
      const waiting = jobs.filter(job => job.state.startsWith('AWAITING')).length
      const ready = jobs.filter(job => isFinished(job.state) && job.prUrl && !job.isReviewed).length
      const parts = [
        running > 0 ? `${running} running` : '',
        waiting > 0 ? `${waiting} need${waiting === 1 ? 's' : ''} input` : '',
        ready > 0 ? `${ready} ready for review` : '',
      ].filter(Boolean)
      julesRow = (
        <Box>
          <Text color={waiting > 0 ? 'warning' : ready > 0 ? 'success' : undefined}>jules: </Text>
          <Text dimColor>{parts.length > 0 ? parts.join(' · ') : `${jobs.length} done`} </Text>
          <Button key="jules-open" label="Jobs" onPress={() => void openJulesPane($)} />
        </Box>
      )
    }

    if (!planRow && !julesRow) return next(e)
    return (
      <Box flexDirection="column">
        {planRow}
        {julesRow}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const target = await read($, plan)
    const current = await read($, run)
    if (!target || !current) return <Text dimColor>Nothing handed off yet.</Text>

    const { progress } = current
    const now = await $.clock.now()
    const isStoppable = progress.outcome === null || (progress.outcome === 'lost' && current.pid !== null)
    const room = Math.max(3, (e.viewport?.rows ?? 30) - progress.commands.length - 10)
    return (
      <Box flexDirection="column">
        <Text bold>{target.path}</Text>
        <Text dimColor>
          {current.mode} · {progress.outcome ?? 'running'} · {duration(now - current.startedAt)} · {progress.steps} steps
          {progress.conversationId ? ` · agy --conversation ${progress.conversationId}` : ''}
        </Text>
        <Text wrap="truncate-end">
          ▸ {progress.activity}
          {quietNote(progress, now)}
        </Text>
        <Text dimColor>Files ({progress.files.length})</Text>
        {progress.files.slice(-room).map(file => (
          <Text key={`file-${file}`} wrap="truncate-start">
            {'  '}
            {file}
          </Text>
        ))}
        {progress.commands.length > 0 ? <Text dimColor>Commands</Text> : null}
        {progress.commands.map((command, i) => (
          <Text key={`cmd-${i}`} dimColor wrap="truncate-end">
            {'  $ '}
            {command}
          </Text>
        ))}
        <Box>
          {isStoppable ? <Button key="stop" label="Stop agy" onPress={() => void stopAgent($)} /> : null}
          <Button key="review" label="Review against plan" onPress={() => void review($)} />
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: JULES_PANE }, async ($, e) => {
    const { Box, Text, Button, Link } = $.ui.resolve(e)
    const jobs = await read($, julesJobs)
    if (jobs.length === 0) return <Text dimColor>No Jules jobs tracked. /handoff jules sends the current plan.</Text>
    const now = await $.clock.now()

    return (
      <Box flexDirection="column">
        {jobs.map(job => {
          const isDone = isFinished(job.state)
          return (
            <Box key={`job-${job.session}`} flexDirection="column" marginBottom={1}>
              <Text bold wrap="truncate-end">
                {job.title}
                {job.plan ? ` (${job.plan.path})` : ''}
              </Text>
              <Text dimColor>
                {job.state} · origin/{job.branch}
                {isDone ? '' : ` · ${duration(now - job.startedAt)}`}
              </Text>
              <Text wrap="truncate-end">▸ {job.activity}</Text>
              <Link href={job.url} label="session" />
              {job.prUrl ? <Link href={job.prUrl} /> : null}
              <Box>
                {isDone && job.prUrl ? (
                  <Button
                    key={`review-${job.session}`}
                    label={job.isReviewed ? 'Review again' : 'Review'}
                    variant={job.isReviewed ? undefined : 'primary'}
                    onPress={() => void reviewJules($, job.session, 'manual')}
                  />
                ) : null}
                <Button key={`forget-${job.session}`} label="Forget" onPress={() => void forgetJules($, job.session)} />
              </Box>
            </Box>
          )
        })}
        <Button key="refresh" label="Refresh" onPress={() => void pollJules($)} />
      </Box>
    )
  })
}
