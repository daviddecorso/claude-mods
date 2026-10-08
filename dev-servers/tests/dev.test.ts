import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { bashIntent } from '../hooks/bash'
import { allocatePort, discover, planScript, portArgs, workspaceGlobs } from '../hooks/discover'
import { LogBuffer, findUrl, query } from '../hooks/logs'

const CFB_SCRIPTS = {
  dev: 'vite',
  'dev:nfl': 'vite --config vite.nfl.config.ts',
  'dev:api': 'wrangler dev',
  build: 'vite build',
  preview: 'vite preview',
}

describe('discover', () => {
  test('names services by script and package dir', async () => {
    const found = discover(
      [
        { dir: '', scripts: CFB_SCRIPTS, hasWrangler: true },
        { dir: 'apps/api', scripts: { dev: 'wrangler dev --env dev' }, hasWrangler: true },
        { dir: 'apps/sink', scripts: { build: 'tsc' }, hasWrangler: true },
        { dir: 'apps/web', scripts: { 'dev:app': 'PORTLESS=0 vite dev', 'dev:kill': 'node kill.mjs' }, hasWrangler: false },
      ],
      'pnpm',
    )
    expect(found.map(s => `${s.name}=${s.kind}`)).toEqual([
      'dev=vite',
      'dev:nfl=vite',
      'dev:api=wrangler',
      'apps/api:dev=wrangler',
      'apps/sink:wrangler=wrangler',
      'apps/web:dev:app=vite',
    ])
    expect(found.find(s => s.name === 'apps/web:dev:app')?.env).toEqual({ PORTLESS: '0' })
  })

  test('shell scripts fall back to the package manager', async () => {
    const service = planScript('', 'dev', 'node scripts/a.mjs && node scripts/b.mjs', 'pnpm')
    expect(service.argv).toEqual(['pnpm', 'run', 'dev'])
    expect(service.kind).toBe('other')
  })

  test('expo runs non-interactively', async () => {
    const service = planScript('', 'dev', 'expo start --private-key-path ./keys/private-key.pem', 'yarn')
    expect(service.kind).toBe('expo')
    expect(service.env.CI).toBe('1')
  })

  test('ports are fixed per kind and skip taken ones', async () => {
    expect(allocatePort('vite', new Set([5180, 5181]))).toBe(5182)
    expect(allocatePort('wrangler', new Set())).toBe(8790)
    expect(allocatePort('other', new Set())).toBeUndefined()
    expect(portArgs('vite', 5180)).toEqual(['--port', '5180', '--strictPort'])
  })

  test('reads workspace globs from pnpm and package.json', async () => {
    expect(workspaceGlobs(undefined, "packages:\n  - 'apps/*'\n  - 'packages/*'\n")).toEqual(['apps/*', 'packages/*'])
    expect(workspaceGlobs({ workspaces: ['app', 'services/*'] }, undefined)).toEqual(['app', 'services/*'])
  })
})

describe('logs', () => {
  test('strips ANSI and QR blocks and splits partial lines', async () => {
    const buffer = new LogBuffer()
    buffer.push('\u001b[32m  ➜  Local:\u001b[39m   http://localhost:5180/\n██████████████\nhalf')
    buffer.push(' a line\n')
    expect(buffer.lines).toEqual(['  ➜  Local:   http://localhost:5180/', 'half a line'])
    expect(findUrl(buffer.lines[0]!)).toBe('http://localhost:5180')
  })

  test('query tails, greps and filters errors with a hard cap', async () => {
    const lines = Array.from({ length: 500 }, (_, i) => (i % 50 === 0 ? `Error: boom ${i}` : `ok ${i}`))
    expect(query(lines, { tail: 5 }).lines).toEqual(['ok 495', 'ok 496', 'ok 497', 'ok 498', 'ok 499'])
    expect(query(lines, { level: 'error' }).matched).toBe(10)
    expect(query(lines, { grep: 'boom 4\\d\\d' }).lines).toEqual(['Error: boom 400', 'Error: boom 450'])
    expect(query(lines, { tail: 10_000 }).lines.length).toBe(200)
  })
})

describe('bashIntent', () => {
  const cases: [string, string][] = [
    ['npm run dev:nfl -- --port 5199 --strictPort', 'start'],
    ['cd /repo; (npm run dev -- --port 5199 > /tmp/x/dev.log 2>&1 &); sleep 3', 'start'],
    ['PORTLESS=0 pnpm dev:app', 'start'],
    ['npx vite --port 5199 --strictPort', 'start'],
    ['npx wrangler dev --port 8799 --ip 127.0.0.1', 'start'],
    ['pkill -f "vite --port 5199"; git status --short', 'kill'],
    ['lsof -ti :5199 | xargs kill 2>/dev/null', 'kill'],
    ['npx vitest run', 'none'],
    ['npm run build && vite build', 'none'],
    ['pnpm dev:kill', 'none'],
    ["python3 - <<'PY'\ns = 'npm run dev'\nPY", 'none'],
    ['grep -n "npm run dev" README.md', 'none'],
  ]
  for (const [command, kind] of cases) {
    test(`${kind}: ${command.split('\n')[0]}`, async () => {
      expect(bashIntent(command).kind).toBe(kind)
    })
  }
})

const ROOT = '/repo'

function ran(exitCode: number, stdout = '') {
  return { value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
}

function fakeRepo(on: On, killed: Set<string>, logged: string[] = []) {
  let release = () => {}
  mock.store(on)
  mock.env(on, { HOME: '/home/me' })
  on('session.id', async () => ({ value: 'sess-1' }))
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('session.cwd', async () => ({ value: ROOT }))
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('tool.register', async (_$, e) => ({ value: { tool: `mcp__dev-servers__${e.name}` } }))
  on('clock.every', async () => ({ value: undefined }))
  on('fs.list', async (_$, e) => ({
    value:
      e.path === ROOT
        ? ['package.json', 'package-lock.json', 'wrangler.jsonc'].map(name => ({ name, kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false }))
        : [],
  }))
  on('fs.read', async (_$, e) => ({
    value: e.path === `${ROOT}/package.json` ? JSON.stringify({ scripts: CFB_SCRIPTS }) : '',
  }))
  on('fs.exists', async (_$, e) => ({ value: e.path === `${ROOT}/wrangler.jsonc` || e.path.endsWith('/node_modules/.bin/vite') }))
  on('process.run', async (_$, e) => {
    const [bin, ...args] = e.argv
    if (bin === '/bin/sh' && e.argv.at(-1)!.endsWith('/mod-logs/dev-servers.jsonl')) {
      logged.push(String(JSON.parse(e.init?.stdin ?? '{}').event))
      return ran(0)
    }
    if (bin === 'git') return ran(0, `${ROOT}\n`)
    if (bin === 'kill' && args[0] === '-TERM') {
      for (const pid of args.slice(1)) killed.add(pid)
      release()
    }
    if (bin === 'kill' && args[0] === '-0') return ran(killed.has(args[1]!) ? 1 : 0)
    return ran(bin === 'lsof' || bin === 'pgrep' ? 1 : 0)
  })
  on('process.spawn', async function* (_$, e) {
    expect(e.argv).toContain('/repo/node_modules/.bin/vite')
    expect(e.argv).toContain('--strictPort')
    yield { stream: 'stdout' as const, text: '__DEVPID 4242\n' }
    yield { stream: 'stdout' as const, text: '  VITE v6  ready\n  ➜  Local:   http://localhost:5181/\n' }
    await new Promise<void>(resolve => {
      release = resolve
    })
    return { value: { code: null, signal: 'SIGTERM' } }
  })
  on('tool.call', { tool: 'Bash' }, async () => ({ result: { stdout: 'ran', stderr: '', interrupted: false } }))
}

const asText = (result: unknown) => JSON.stringify(result)

describe('engine', () => {
  test('lists services, redirects Bash, and starts and stops only its own tree', async ($, on) => {
    const killed = new Set<string>()
    const logged: string[] = []
    fakeRepo(on, killed, logged)
    await $.session.start({ cwd: ROOT, surface: null, isInteractive: true })

    const listed = await $.tool.call({ tool: 'mcp__dev-servers__dev_list' })
    expect(asText(listed)).toContain('dev:nfl: stopped')
    expect(asText(listed)).toContain('dev:api: stopped')
    expect(asText(listed)).not.toContain(':wrangler')

    const redirected = await $.tool.call({ tool: 'Bash', command: 'npm run dev:nfl -- --port 5199', description: 'start' })
    expect(asText(redirected)).toContain('dev_start { name: \\"dev:nfl\\" }')
    const killing = await $.tool.call({ tool: 'Bash', command: 'pkill -f "vite"', description: 'kill' })
    expect(asText(killing)).toContain("don't kill dev servers")
    const unrelated = await $.tool.call({ tool: 'Bash', command: 'npm run build', description: 'build' })
    expect(asText(unrelated)).toContain('ran')

    const started = await $.tool.call({ tool: 'mcp__dev-servers__dev_start', name: 'dev:nfl' })
    expect(asText(started)).toContain('dev:nfl: running · http://localhost:5181 · pid 4242')

    const logs = await $.tool.call({ tool: 'mcp__dev-servers__dev_logs', name: 'dev:nfl', grep: 'local' })
    expect(asText(logs)).toContain('1 of 1 matching lines')

    const stopped = await $.tool.call({ tool: 'mcp__dev-servers__dev_stop', name: 'dev:nfl' })
    expect(asText(stopped)).toContain('dev:nfl stopped')
    expect([...killed]).toEqual(['4242'])
    for (const event of ['tool', 'bash-block', 'started']) expect(logged).toContain(event)
  })

  test('the pane draws a row per service on terminal and desktop', async ($, on) => {
    fakeRepo(on, new Set())
    await $.session.start({ cwd: ROOT, surface: null, isInteractive: true })

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({
        plugin: 'dev-servers',
        surface,
        component: 'Pane',
        requestId: 'dev-servers',
        props: {
          title: 'Dev servers',
          isFocused: true,
          bodyColumns: 100,
          placement: 'dock',
          scroll: { offset: 0, bodyRows: 30 },
          view: {},
        },
      })
      expect(await ui.find({ key: 'start-dev:nfl' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /stopped/ })).toBeDefined()
      await ui.unmount()
    }
  })
})
