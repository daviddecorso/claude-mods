import { atom, read, update } from 'claude-code'
import type { EngineInterface, HookStream, ProcessSpawnChunk, ProcessSpawnResult, Register, Timer } from 'claude-code'

import type { ServiceView } from '../types'
import { bashIntent } from './bash'
import {
  allocatePort,
  detectPackageManager,
  discover,
  planScript,
  portArgs,
  portRange,
  workspaceGlobs,
  type PackageInfo,
  type PackageManager,
  type Service,
} from './discover'
import { LogBuffer, findUrl, query } from './logs'

type $ = EngineInterface

type Running = {
  stream: HookStream<ProcessSpawnChunk, ProcessSpawnResult>
  pid?: number
  isStopping: boolean
}

type ToolArgs = Record<string, unknown>

const PANE = 'dev-servers'
const PID_MARK = '__DEVPID '
const START_WAIT_MS = 20_000
const PANE_TAIL = 40
const RUNNERS = new Set(['npm', 'pnpm', 'yarn', 'bun', 'node', 'deno', 'tsx', 'npx', 'bunx', 'sh', 'bash'])
const STATUS_COLOR = { running: 'success', starting: 'warning', crashed: 'error', blocked: 'error', stopped: 'inactive' } as const

const services = atom({ plugin: 'dev-servers', key: 'services' } as const, [] as ServiceView[])
const selected = atom({ plugin: 'dev-servers', key: 'selected' } as const, '')
const tail = atom({ plugin: 'dev-servers', key: 'tail' } as const, [] as string[])

// Process handles and log buffers live only in this module: a hot reload of the mod kills its servers.
let root = ''
let pm: PackageManager = 'npm'
const defs = new Map<string, Service>()
const logs = new Map<string, LogBuffer>()
const running = new Map<string, Running>()
let isTailDirty = false
let tick: Timer | undefined

// Appends one line to ~/.claude/mod-logs/dev-servers.jsonl, which /mods-report reads; never fails the hook.
async function logEvent($: $, event: Record<string, unknown>) {
  try {
    const home = await $.env.get('HOME')
    const line = JSON.stringify({ at: new Date().toISOString(), session: await $.session.id(), root, ...event })
    await $.process.run(
      ['/bin/sh', '-c', 'mkdir -p "$(dirname "$1")" && cat >> "$1"', 'sh', `${home}/.claude/mod-logs/dev-servers.jsonl`],
      { stdin: `${line}\n` },
    )
  } catch {
    // Logging is best effort.
  }
}

function text(body: string) {
  return { result: { content: [{ type: 'text' as const, text: body }], isError: false } }
}

function names() {
  return [...defs.keys()].join(', ')
}

function describe(service: ServiceView | undefined): string {
  if (!service) return 'Unknown service.'
  const parts = [`${service.name}: ${service.status}`]
  if (service.url) parts.push(service.url)
  else if (service.port !== null) parts.push(`port ${service.port}`)
  if (service.pid !== null) parts.push(`pid ${service.pid}`)
  if (service.note) parts.push(`(${service.note})`)

  return parts.join(' · ')
}

async function pause($: $, ms: number) {
  await $.process.run(['sleep', String(ms / 1000)])
}

async function view($: $, name: string) {
  return (await read($, services)).find(s => s.name === name)
}

async function setView($: $, name: string, patch: Partial<ServiceView>) {
  await update($, services, list => list.map(s => (s.name === name ? { ...s, ...patch } : s)))
}

async function readJson($: $, path: string): Promise<unknown> {
  try {
    return JSON.parse(String(await $.fs.read(path)))
  } catch {
    return undefined
  }
}

async function packageAt($: $, dir: string): Promise<PackageInfo | undefined> {
  const abs = dir ? `${root}/${dir}` : root
  const json = (await readJson($, `${abs}/package.json`)) as { scripts?: Record<string, string> } | undefined
  if (!json) return undefined
  const hasWrangler =
    (await $.fs.exists(`${abs}/wrangler.jsonc`)) ||
    (await $.fs.exists(`${abs}/wrangler.json`)) ||
    (await $.fs.exists(`${abs}/wrangler.toml`))

  return { dir, scripts: json.scripts ?? {}, hasWrangler }
}

async function listDirs($: $, path: string): Promise<string[]> {
  try {
    return (await $.fs.list(path)).filter(entry => entry.kind === 'dir').map(entry => entry.name)
  } catch {
    return []
  }
}

async function scan($: $) {
  const top = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd: await $.session.cwd() })
  root = top.exitCode === 0 ? top.stdout.trim() : ''
  defs.clear()
  if (!root) {
    await update($, services, () => [])
    return
  }

  const entries = await $.fs.list(root)
  pm = detectPackageManager(new Set(entries.map(entry => entry.name)))
  const rootJson = await readJson($, `${root}/package.json`)
  const yaml = entries.some(entry => entry.name === 'pnpm-workspace.yaml')
    ? String(await $.fs.read(`${root}/pnpm-workspace.yaml`))
    : undefined

  const dirs = new Set([''])
  for (const glob of workspaceGlobs(rootJson, yaml)) {
    const clean = glob.replace(/\/+$/, '')
    if (clean.endsWith('/*')) {
      const parent = clean.slice(0, -2)
      for (const child of await listDirs($, `${root}/${parent}`)) dirs.add(`${parent}/${child}`)
    } else if (!clean.includes('*')) {
      dirs.add(clean)
    }
  }

  const packages: PackageInfo[] = []
  for (const dir of dirs) {
    const pkg = await packageAt($, dir)
    if (pkg) packages.push(pkg)
  }

  const custom = ((await $.store.get(`custom:${root}`)) ?? []) as Service[]
  for (const service of [...discover(packages, pm), ...custom]) defs.set(service.name, service)

  const ports = ((await $.store.get('ports')) ?? {}) as Record<string, number>
  await update($, services, previous =>
    [...defs.values()].map(
      service =>
        previous.find(s => s.name === service.name && running.has(s.name)) ?? {
          name: service.name,
          status: 'stopped',
          port: ports[`${root}::${service.name}`] ?? null,
          url: null,
          pid: null,
          note: null,
        },
    ),
  )
  if (!defs.has(await read($, selected))) await update($, selected, () => defs.keys().next().value ?? '')
}

async function portFor($: $, service: Service): Promise<number | undefined> {
  if (!portRange(service.kind)) return undefined
  const ports = ((await $.store.get('ports')) ?? {}) as Record<string, number>
  const key = `${root}::${service.name}`
  if (ports[key] !== undefined) return ports[key]
  const port = allocatePort(service.kind, new Set(Object.values(ports)))
  if (port !== undefined) await $.store.set('ports', { ...ports, [key]: port })

  return port
}

async function listener($: $, port: number) {
  const found = await $.process.run(['lsof', '-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpc'])
  const pid = /^p(\d+)/m.exec(found.stdout)?.[1]

  return pid ? { pid: Number(pid), command: /^c(.*)$/m.exec(found.stdout)?.[1] ?? '?' } : undefined
}

async function processTree($: $, pid: number): Promise<number[]> {
  const children = await $.process.run(['pgrep', '-P', String(pid)])
  const all = [pid]
  for (const child of children.stdout.split('\n').filter(Boolean)) all.push(...(await processTree($, Number(child))))

  return all
}

async function alive($: $, pids: string[]): Promise<string[]> {
  const still: string[] = []
  for (const pid of pids) if ((await $.process.run(['kill', '-0', pid])).exitCode === 0) still.push(pid)

  return still
}

async function killTree($: $, pid: number, shouldWait: boolean) {
  const pids = (await processTree($, pid)).map(String)
  await $.process.run(['kill', '-TERM', ...pids])
  if (!shouldWait) return
  for (let i = 0; i < 10; i++) {
    if ((await alive($, pids)).length === 0) return
    await pause($, 300)
  }
  const stuck = await alive($, pids)
  if (stuck.length > 0) await $.process.run(['kill', '-KILL', ...stuck])
}

async function resolveArgv($: $, service: Service): Promise<string[]> {
  const bin = service.argv[0]!
  if (RUNNERS.has(bin) || bin.includes('/')) return service.argv
  for (const dir of service.dir ? [`${root}/${service.dir}`, root] : [root]) {
    const path = `${dir}/node_modules/.bin/${bin}`
    if (await $.fs.exists(path)) return [path, ...service.argv.slice(1)]
  }

  return service.script ? [pm, 'run', service.script] : ['npx', ...service.argv]
}

async function pump($: $, name: string, entry: Running) {
  const buffer = logs.get(name)!
  let ended: ProcessSpawnResult | undefined
  try {
    while (true) {
      const step = await entry.stream.next()
      if (step.done) {
        ended = step.value
        break
      }
      for (const line of buffer.push(step.value.text)) {
        if (line.startsWith(PID_MARK) && entry.pid === undefined) {
          entry.pid = Number(line.slice(PID_MARK.length))
          buffer.lines = buffer.lines.filter(l => !l.startsWith(PID_MARK))
          await setView($, name, { pid: entry.pid })
          continue
        }
        const url = findUrl(line)
        if (url && !(await view($, name))?.url) await setView($, name, { status: 'running', url })
      }
      if (name === (await read($, selected))) isTailDirty = true
    }
  } catch (error) {
    buffer.push(`[dev-servers] ${String(error)}\n`)
  }

  running.delete(name)
  const isClean = entry.isStopping || ended?.code === 0
  if (!isClean) void logEvent($, { event: 'crash', service: name, code: ended?.code ?? null, signal: ended?.signal ?? null })
  await setView($, name, {
    status: isClean ? 'stopped' : 'crashed',
    pid: null,
    url: null,
    note: isClean ? null : `exited with ${ended?.code ?? ended?.signal ?? 'an error'}`,
  })
  isTailDirty = true
}

async function start($: $, name: string): Promise<string> {
  const service = defs.get(name)
  if (!service) return `No service named "${name}". Services: ${names()}.`
  if (running.has(name)) return describe(await view($, name))

  const port = await portFor($, service)
  if (port !== undefined) {
    const holder = await listener($, port)
    if (holder) {
      const note = `port ${port} held by pid ${holder.pid} (${holder.command})`
      void logEvent($, { event: 'collision', service: name, port, holder: holder.command })
      await setView($, name, { status: 'blocked', port, note })
      return `${name} not started: ${note}, which dev-servers did not start. Ask the user whether that is their own server; do not kill it.`
    }
  }

  const argv = [...(await resolveArgv($, service)), ...(port !== undefined ? portArgs(service.kind, port) : [])]
  const buffer = logs.get(name) ?? new LogBuffer()
  buffer.clear()
  logs.set(name, buffer)
  buffer.push(`$ ${argv.join(' ')}\n`)

  // The shell prints its own pid, then exec keeps it, so the pid is the server's and its tree can be stopped exactly.
  const stream = $.process.spawn({
    argv: ['/bin/sh', '-c', `echo "${PID_MARK}$$"; exec "$@"`, 'sh', ...argv],
    cwd: service.dir ? `${root}/${service.dir}` : root,
    env: { BROWSER: 'none', NO_COLOR: '1', FORCE_COLOR: '0', ...service.env },
  })
  const entry: Running = { stream, isStopping: false }
  running.set(name, entry)
  await setView($, name, { status: 'starting', port: port ?? null, url: null, pid: null, note: null })
  void pump($, name, entry)

  for (let waited = 0; waited < START_WAIT_MS; waited += 500) {
    const current = await view($, name)
    if (current?.status !== 'starting') {
      void logEvent($, { event: 'started', service: name, kind: service.kind, port: port ?? null, status: current?.status, waitedMs: waited })
      return describe(current)
    }
    await pause($, 500)
  }
  await setView($, name, { status: 'running', note: 'no URL in its output yet' })
  void logEvent($, { event: 'started', service: name, kind: service.kind, port: port ?? null, status: 'no-url', waitedMs: START_WAIT_MS })

  return describe(await view($, name))
}

async function stop($: $, name: string): Promise<string> {
  const entry = running.get(name)
  if (!entry) return `${name} is not running.`
  entry.isStopping = true
  if (entry.pid !== undefined) await killTree($, entry.pid, true)
  else await entry.stream.return(undefined as never)
  for (let i = 0; i < 20 && running.has(name); i++) await pause($, 200)

  return `${name} stopped.`
}

async function restart($: $, name: string): Promise<string> {
  if (running.has(name)) await stop($, name)
  return start($, name)
}

async function list($: $): Promise<string> {
  const all = await read($, services)
  if (all.length === 0) return 'No dev servers found: not in a git repo, or no dev scripts or wrangler configs.'
  return all.map(describe).join('\n')
}

async function logsFor($: $, args: ToolArgs): Promise<string> {
  const name = String(args.name ?? '')
  if (!defs.has(name)) return `No service named "${name}". Services: ${names()}.`
  const buffer = logs.get(name)
  if (!buffer || buffer.lines.length === 0) return `${name} has no output yet.`
  const found = query(buffer.lines, {
    tail: typeof args.tail === 'number' ? args.tail : 50,
    grep: typeof args.grep === 'string' ? args.grep : undefined,
    level: args.level === 'error' ? 'error' : 'all',
  })
  const header = `${describe(await view($, name))}\n${found.lines.length} of ${found.matched} matching lines since last start:`

  return `${header}\n${found.lines.join('\n')}`
}

async function selectService($: $, name: string) {
  await update($, selected, () => name)
  await update($, tail, () => logs.get(name)?.lines.slice(-PANE_TAIL) ?? [])
}

async function refreshTail($: $) {
  const lines = logs.get(await read($, selected))?.lines ?? []
  await update($, tail, () => lines.slice(-PANE_TAIL))
}

async function stopAll($: $) {
  for (const entry of running.values()) {
    entry.isStopping = true
    if (entry.pid !== undefined) await killTree($, entry.pid, false)
  }
}

async function addCustom($: $, name: string, dir: string, command: string): Promise<string> {
  const service = { ...planScript(dir === '.' ? '' : dir, name, command, pm), name }
  const key = `custom:${root}`
  const custom = ((await $.store.get(key)) ?? []) as Service[]
  await $.store.set(key, [...custom.filter(s => s.name !== name), service])
  await scan($)

  return `Added ${name} (${service.kind}) in ${dir}.`
}

async function registerTools($: $) {
  const nameProp = { name: { type: 'string', description: 'Service name, as dev_list shows it' } }
  const nameSchema = { type: 'object', properties: nameProp, required: ['name'] }

  await $.tool.register({
    name: 'dev_list',
    description:
      "Lists this repo's dev servers (named services, e.g. 'dev', 'dev:nfl', 'apps/api:wrangler') with status, fixed port, URL and pid. Use instead of starting a dev server through Bash or looking for one with lsof/ps.",
  })
  await $.tool.register({
    name: 'dev_start',
    description:
      'Starts a dev server on its fixed port and waits until it prints its URL (up to 20s). Never kills anything: if the port is taken it reports who holds it.',
    inputSchema: nameSchema,
  })
  await $.tool.register({
    name: 'dev_stop',
    description: 'Stops a dev server this tool started (its whole process tree). It cannot stop servers the user started.',
    inputSchema: nameSchema,
  })
  await $.tool.register({
    name: 'dev_restart',
    description: 'Restarts a dev server (starts it if it is not running).',
    inputSchema: nameSchema,
  })
  await $.tool.register({
    name: 'dev_logs',
    description:
      "Reads a dev server's output since its last start, ANSI and QR codes stripped. Keep it small: tail defaults to 50 lines (max 200); grep filters by a case-insensitive regex; level 'error' keeps error-looking lines.",
    inputSchema: {
      type: 'object',
      properties: {
        ...nameProp,
        tail: { type: 'number', description: 'Lines from the end (default 50, max 200)' },
        grep: { type: 'string', description: 'Case-insensitive regex to keep matching lines' },
        level: { type: 'string', enum: ['all', 'error'] },
      },
      required: ['name'],
    },
  })
}

function bashDenial(command: string): string | undefined {
  if (defs.size === 0) return undefined
  const intent = bashIntent(command)
  if (intent.kind === 'none') return undefined

  const all = [...defs.keys()]
  if (intent.kind === 'kill') {
    return `dev-servers: don't kill dev servers from Bash (${intent.pattern}); it can take down the user's own server. Use mcp__dev-servers__dev_stop or dev_restart for the ones dev-servers runs (${all.join(', ')}). If something else holds a port, tell the user.`
  }

  const wanted = intent.script ?? intent.tool ?? ''
  const matches = all.filter(name => name === wanted || name.endsWith(`:${wanted}`) || defs.get(name)!.kind === wanted)
  const suggestion = matches.length > 0 ? matches : all

  return `dev-servers runs this repo's dev servers on fixed ports. Use mcp__dev-servers__dev_start { name: "${suggestion[0]}" } instead${
    suggestion.length > 1 ? ` (services: ${suggestion.join(', ')})` : ''
  }, then dev_logs { name, tail, grep } to read its output.`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await scan($)
    await $.command.register({
      name: 'dev',
      description: 'Dev servers: open the pane, or start/stop/restart <name>, rescan, add <name> <dir> <command>',
      argumentHint: '[start|stop|restart <name> | rescan | add <name> <dir> <command>]',
    })
    await registerTools($)

    tick?.cancel()
    tick = $.clock.every(500, () => {
      if (!isTailDirty) return
      isTailDirty = false
      void refreshTail($)
    })

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await stopAll($)
    return next(e)
  })

  on('tool.call', { tool: 'mcp__dev-servers__dev_list' }, async $ => {
    void logEvent($, { event: 'tool', tool: 'dev_list' })
    return text(await list($))
  })
  on('tool.call', { tool: 'mcp__dev-servers__dev_start' }, async ($, e) => {
    void logEvent($, { event: 'tool', tool: 'dev_start', service: e.name })
    return text(await start($, String(e.name ?? '')))
  })
  on('tool.call', { tool: 'mcp__dev-servers__dev_stop' }, async ($, e) => {
    void logEvent($, { event: 'tool', tool: 'dev_stop', service: e.name })
    return text(await stop($, String(e.name ?? '')))
  })
  on('tool.call', { tool: 'mcp__dev-servers__dev_restart' }, async ($, e) => {
    void logEvent($, { event: 'tool', tool: 'dev_restart', service: e.name })
    return text(await restart($, String(e.name ?? '')))
  })
  on('tool.call', { tool: 'mcp__dev-servers__dev_logs' }, async ($, e) => {
    void logEvent($, { event: 'tool', tool: 'dev_logs', service: e.name, tail: e.tail, grep: e.grep, level: e.level })
    return text(await logsFor($, e))
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const deny = bashDenial(e.command)
    if (deny === undefined) return next(e)
    void logEvent($, { event: 'bash-block', kind: bashIntent(e.command).kind, command: e.command.slice(0, 400) })
    return { deny }
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'dev' }, async ($, e) => {
    const [verb = '', name = '', dir = '', ...command] = e.args.trim().split(/\s+/)

    if (verb === 'rescan') {
      await scan($)
      return { text: `Found ${defs.size} services: ${names()}` }
    }
    if (verb === 'add' && name && dir && command.length > 0) return { text: await addCustom($, name, dir, command.join(' ')) }
    if (verb === 'start') return { text: await start($, name) }
    if (verb === 'stop') return { text: await stop($, name) }
    if (verb === 'restart') return { text: await restart($, name) }

    await $.ui.open({ id: PANE, title: 'Dev servers' })
    return { text: defs.size > 0 ? 'Dev servers pane opened.' : 'No dev servers found in this repo.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const all = await read($, services)
    const current = await read($, selected)
    const lines = await read($, tail)
    const room = Math.max(3, (e.viewport?.rows ?? 30) - all.length - 6)

    if (all.length === 0) {
      return <Text dimColor>No dev servers found. Run /dev rescan from inside a repo.</Text>
    }

    return (
      <Box flexDirection="column">
        {all.map(service => (
          <Box key={`row-${service.name}`}>
            <Button
              key={`pick-${service.name}`}
              plain
              label={`${service.name === current ? '▸' : ' '} ${service.name}`}
              onPress={() => selectService($, service.name)}
            />
            <Text color={STATUS_COLOR[service.status]}> {service.status} </Text>
            <Text dimColor>{service.url ?? (service.port !== null ? `:${service.port}` : '')} </Text>
            {service.status === 'running' || service.status === 'starting' ? (
              <Box>
                <Button key={`restart-${service.name}`} label="Restart" onPress={() => void restart($, service.name)} />
                <Button key={`stop-${service.name}`} label="Stop" onPress={() => void stop($, service.name)} />
              </Box>
            ) : (
              <Button key={`start-${service.name}`} label="Start" onPress={() => void start($, service.name)} />
            )}
            {service.note ? <Text color="warning"> {service.note}</Text> : null}
          </Box>
        ))}
        <Text dimColor>── {current} ──</Text>
        {lines.slice(-room).map((line, i) => (
          <Text key={`log-${i}`} wrap="truncate-end">
            {line}
          </Text>
        ))}
      </Box>
    )
  })
}
