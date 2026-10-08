import { describe, expect, mock, test } from 'claude-code/testing'

import { classify, denial } from '../hooks/classify'
import { afterBlock } from '../hooks/outcome'

// The test runner has timers; the hooks module's type environment does not declare them.
declare const setTimeout: (fn: () => void, ms: number) => unknown

const CWD = '/Users/me/code/app'
const SCRATCH = '/private/tmp/claude-501/-Users-me-code-app/abc/scratchpad'

const PY_EDIT = `cd /Users/me/code/app; python3 - <<'EOF'
p='src/nfl/pages/Games.tsx'
s=open(p).read()
old = "if (x > 5) {"
assert old in s
s=s.replace(old, "if (x > 6) {")
open(p,'w').write(s)
EOF`

const MUST_WRITE: [string, string, string[]][] = [
  ['python heredoc rewrite', PY_EDIT, ['src/nfl/pages/Games.tsx']],
  ['sed -i on macOS', `sed -i '' 's/round(g.close, 1)/round(g.close, 2)/' src/utils/pollPicks.ts && grep -n round src/utils/pollPicks.ts`, ['src/utils/pollPicks.ts']],
  ['perl -pi', `perl -0pi -e 's/a/b/' src/features/collections/useCollectionEntries.ts; pnpm exec tsc`, ['src/features/collections/useCollectionEntries.ts']],
  ['node -e writeFileSync', `node -e "const fs=require('fs');fs.writeFileSync('src/data/x.json', '{}')"`, ['src/data/x.json']],
  ['cat heredoc into src', `cat > src/components/QbFooter.tsx <<'EOF'\nexport const QbFooter = () => null\nEOF`, ['src/components/QbFooter.tsx']],
  ['append heredoc', `cat >> src/utils/predictions.ts <<'EOF'\nexport const x = 1\nEOF`, ['src/utils/predictions.ts']],
  ['tee into repo', `echo '{}' | tee bundle-budget.json`, ['bundle-budget.json']],
  ['printf redirect', `printf '{\\n}\\n' > bundle-budget.json`, ['bundle-budget.json']],
  ['python -c write_text', `python3 -c "from pathlib import Path; Path('docs/a.md').write_text('x')"`, ['docs/a.md']],
  ['absolute path outside temp', `echo x >> /Users/me/.zshrc`, ['/Users/me/.zshrc']],
]

const MUST_ALLOW: [string, string][] = [
  ['prettier --write', 'pnpm exec prettier --write src'],
  ['dev server log to scratch', `npm run dev -- --port 5199 > ${SCRATCH}/vite.log 2>&1`],
  ['scratch var log', `S=${SCRATCH}; npx vite dev --port 5199 > $S/vite.log 2>&1 &`],
  ['codegen redirect', 'npx supabase gen types typescript --local > src/types/db.ts'],
  ['install', 'pnpm install'],
  ['sed -n read', 'sed -n 1,80p src/nfl/qbRankings.ts'],
  ['python print', `python3 -c 'print(1 > 0)'`],
  ['git', 'git add -A && git commit -q -m "x > y"'],
  ['cat to tmp', `cat > ${SCRATCH}/check.ts <<'EOF'\nimport fs from "node:fs"\nfs.writeFileSync("src/x.ts", "")\nEOF`],
  ['stderr to null', 'npx tsc --noEmit 2>/dev/null | head'],
  ['python in scratch dir', `cd ${SCRATCH}/hand && python3 - <<'EOF'\ns=open('gen.mjs').read()\nopen('gen.mjs','w').write(s)\nEOF`],
  ['script file run', 'python3 scripts/fetch.py --season 2025'],
  ['grep with > in pattern', `grep -n "a > b" src/x.ts`],
  ['window.open in python string', `python3 - <<'EOF'\nprint("window.open(url, 'w')")\nEOF`],
]

describe('classify', () => {
  for (const [name, command, targets] of MUST_WRITE) {
    test(`blocks: ${name}`, async () => {
      const verdict = classify(command, { cwd: CWD })
      expect(verdict.kind).toBe('write')
      if (verdict.kind === 'write') expect(verdict.targets).toEqual(targets)
    })
  }

  for (const [name, command] of MUST_ALLOW) {
    test(`allows: ${name}`, async () => {
      expect(classify(command, { cwd: CWD }).kind).toBe('allow')
    })
  }

  test('a loop of in-place edits is bulk', async () => {
    const verdict = classify(`for f in src/a.ts src/b.ts; do sed -i '' 's/a/b/' "$f"; done`, { cwd: CWD })
    expect(verdict.kind === 'write' && verdict.isBulk).toBe(true)
  })

  test('xargs sed is bulk', async () => {
    const verdict = classify(`grep -rl "•" src/ | xargs sed -i '' 's/•/·/g'`, { cwd: CWD })
    expect(verdict.kind === 'write' && verdict.isBulk).toBe(true)
  })

  test('extraAllowed lets a matching command through', async () => {
    const command = 'node scripts/gen-icons.mjs > src/icons.ts'
    expect(classify(command, { cwd: CWD }).kind).toBe('write')
    expect(classify(command, { cwd: CWD, extraAllowed: /^node scripts\/gen-/ }).kind).toBe('allow')
  })

  test('the denial names the file and the tool', async () => {
    const verdict = classify(PY_EDIT, { cwd: CWD })
    if (verdict.kind !== 'write') throw new Error('expected a write')
    expect(denial(verdict)).toContain('Use Edit on src/nfl/pages/Games.tsx')
  })
})

describe('hook', () => {
  test('denies a shell edit, honours allow-once, then caps retries', async ($, on) => {
    let ran = 0
    on('session.cwd', async () => ({ value: CWD }))
    on('ui.status', async () => ({ value: undefined }))
    on('tool.call', { tool: 'Bash' }, async () => {
      ran += 1
      return { result: { stdout: '', stderr: '', interrupted: false } }
    })

    const command = `sed -i '' 's/a/b/' src/x.ts`
    const denied = await $.tool.call({ tool: 'Bash', command, description: 'edit' })
    expect(JSON.stringify(denied)).toContain('Use Edit on src/x.ts')
    expect(ran).toBe(0)

    await $.command.run({
      command: 'edit-guard',
      args: 'allow-once',
      origin: { kind: 'composer' },
      presentation: { isFullscreen: false, columns: 120 },
    })
    await $.tool.call({ tool: 'Bash', command, description: 'edit' })
    expect(ran).toBe(1)

    await $.tool.call({ tool: 'Bash', command: 'ls src', description: 'list' })
    expect(ran).toBe(2)

    for (let i = 0; i < 3; i++) await $.tool.call({ tool: 'Bash', command, description: 'edit' })
    const capped = await $.tool.call({ tool: 'Bash', command, description: 'edit' })
    expect(JSON.stringify(capped)).toContain('Stop retrying')
  })

  test('logs each block and what the model did next', async ($, on) => {
    const appended: { path: string; line: Record<string, unknown> }[] = []
    mock.env(on, { HOME: '/home/me' })
    on('session.id', async () => ({ value: 'sess-1' }))
    on('session.cwd', async () => ({ value: CWD }))
    on('ui.status', async () => ({ value: undefined }))
    on('process.run', async (_$, e) => {
      appended.push({ path: e.argv.at(-1)!, line: JSON.parse(e.init?.stdin ?? '{}') })
      return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })
    on('tool.call', { tool: 'Edit' }, async () => ({ result: {} }) as never)

    await $.tool.call({ tool: 'Bash', command: `sed -i '' 's/a/b/' src/x.ts`, description: 'edit' })
    await $.tool.call({ tool: 'Edit', file_path: `${CWD}/src/x.ts`, old_string: 'a', new_string: 'b' })
    for (let i = 0; i < 50 && appended.length < 2; i++) await new Promise<void>(resolve => setTimeout(resolve, 5))

    expect(appended.map(a => a.line.event)).toEqual(['block', 'after-block'])
    expect(appended[0]!.path).toBe('/home/me/.claude/mod-logs/shell-edit-guard.jsonl')
    expect(appended[0]!.line).toMatchObject({ session: 'sess-1', via: 'in-place', targets: ['src/x.ts'] })
    expect(appended[1]!.line).toMatchObject({ outcome: 'edit-same-file', tool: 'Edit' })
  })
})

describe('afterBlock', () => {
  test('classifies the follow-up call', async () => {
    expect(afterBlock(['src/x.ts'], 'Edit', '/repo/src/x.ts', false)).toBe('edit-same-file')
    expect(afterBlock(['src/x.ts'], 'Write', '/repo/src/y.ts', false)).toBe('edit-other-file')
    expect(afterBlock(['src/x.ts'], 'Bash', undefined, true)).toBe('shell-retry')
    expect(afterBlock(['src/x.ts'], 'Bash', undefined, false)).toBe('bash-other')
    expect(afterBlock(['src/x.ts'], 'Read', '/repo/src/x.ts', false)).toBe('other')
  })
})
