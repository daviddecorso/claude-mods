import { assignments, commandWords, expand, parse } from './shell'

export type Via = 'interpreter' | 'in-place' | 'redirect' | 'tee'

export type Verdict =
  | { kind: 'allow' }
  | { kind: 'write'; via: Via; targets: string[]; isBulk: boolean }

export type Context = {
  cwd: string
  extraAllowed?: RegExp
}

type Found = { via: Via; targets: string[]; isBulk: boolean }

const TEMP_PREFIXES = ['/tmp/', '/private/tmp/', '/var/folders/', '/private/var/folders/', '/dev/']

const INTERPRETERS = /^(python(3(\.\d+)?)?|node|bun|deno|ruby|perl|tsx|ts-node)$/
const CODE_FLAGS = new Set(['-c', '-e', '-E', '--eval', '-p', '--print', 'eval'])

const WRITE_APIS = [
  /(?<![.\w$])open\s*\([^)]*,\s*(f?['"])(w|a|x|r\+|wb|ab|w\+|a\+)\1/,
  /(?<![.\w$])open\s*\([^)]*\bmode\s*=\s*['"](w|a|x)/,
  /\.write_(text|bytes)\s*\(/,
  /\b(writeFile|appendFile)(Sync)?\s*\(/,
  /\bfs\.(promises\.)?(write|truncate|copyFile|rename)/,
  /\bcreateWriteStream\s*\(/,
  /\bFile\.(write|open\([^)]*['"]w)/,
  /\bBun\.write\s*\(/,
  /\bDeno\.write(Text)?File/,
  /\bopen\s*\(?\s*(my\s+)?\$?\w+\s*,\s*['"]\+?>/,
  /\bshutil\.(copy|move)/,
  /\bos\.(rename|replace)\s*\(/,
]

const BULK_HINTS = /\b(os\.walk|\.rglob|\.glob\(|glob\.glob|readdirSync|readdir\(|globSync|fast-glob)/

// Commands whose redirected output is a generated artifact rather than a hand edit (codegen, package scripts).
const ALLOWED_WRITERS =
  /^(prettier|biome|eslint|oxlint|dprint|stylelint|git|gh|tsc|vitest|jest|playwright|turbo|nx|wrangler|supabase|jscodeshift|ast-grep|sg|npm|pnpm|yarn|bun|npx|bunx|pnpx|corepack)$/

export function isTempPath(path: string): boolean {
  return path === '/dev/null' || TEMP_PREFIXES.some(prefix => path.startsWith(prefix))
}

function resolve(path: string, cwd: string): string {
  if (path.startsWith('/') || path.startsWith('~') || path.startsWith('$')) return path
  const out: string[] = []
  for (const part of `${cwd}/${path}`.split('/')) {
    if (part === '..') out.pop()
    else if (part !== '.' && part !== '') out.push(part)
  }

  return `/${out.join('/')}`
}

function display(path: string, cwd: string): string {
  return path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path
}

function interpreterTargets(source: string): string[] {
  const literal = `(['"\`])([^'"\`\\n]+)\\1`
  const targets = new Set<string>()

  for (const pattern of [
    new RegExp(`(?<![.\\w$])open\\s*\\(\\s*f?${literal}`, 'g'),
    new RegExp(`\\b(?:writeFile|appendFile)(?:Sync)?\\s*\\(\\s*${literal}`, 'g'),
    new RegExp(`\\b(?:Bun\\.write|Deno\\.writeTextFile|Deno\\.writeFile|createWriteStream)\\s*\\(\\s*${literal}`, 'g'),
    new RegExp(`\\bPath\\s*\\(\\s*${literal}\\s*\\)\\s*\\.write_`, 'g'),
  ]) {
    for (const match of source.matchAll(pattern)) targets.add(match.at(-1)!)
  }

  const variables = new Map<string, string>()
  for (const match of source.matchAll(
    /\b(?:const|let|var|my)?\s*\$?([A-Za-z_]\w*)\s*=\s*(?:Path\s*\(\s*|path\.(?:join|resolve)\s*\(\s*)?(['"`])([^'"`\n]+)\2/g,
  )) {
    variables.set(match[1]!, match[3]!)
  }
  for (const [name, path] of variables) {
    const uses = new RegExp(
      `\\bopen\\s*\\(\\s*\\$?${name}\\b|\\b${name}\\.write_|\\b(?:writeFile|appendFile)(?:Sync)?\\s*\\(\\s*${name}\\b|\\bBun\\.write\\s*\\(\\s*${name}\\b`,
    )
    if (uses.test(source)) targets.add(path)
  }

  return [...targets]
}

// The code an interpreter runs inline (`-c`/`-e` argument or a heredoc on stdin); undefined when it runs a script file.
function inlineSource(words: string[], heredocs: string[]): string | undefined {
  const name = (words[0] ?? '').split('/').at(-1) ?? ''
  if (!INTERPRETERS.test(name)) return undefined

  const parts: string[] = []
  let script: string | undefined
  for (let i = 1; i < words.length; i++) {
    const w = words[i]!
    if (CODE_FLAGS.has(w)) {
      parts.push(words[i + 1] ?? '')
      i += 1
    } else if (w === '-m' || w === '-' || !w.startsWith('-')) {
      script = w
      break
    }
  }
  if (parts.length === 0 && heredocs.length > 0 && (script === undefined || script === '-')) parts.push(...heredocs)

  return parts.length > 0 ? parts.join('\n') : undefined
}

// The file operands of `sed -i` / `perl -pi`: everything after the script that is not a flag.
function inPlaceOperands(words: string[], scriptFlag: RegExp): string[] {
  const operands: string[] = []
  let hasScript = words.some(w => scriptFlag.test(w))
  for (let i = 1; i < words.length; i++) {
    const w = words[i]!
    if (scriptFlag.test(w) || w === '-f') {
      i += 1
    } else if (!w.startsWith('-') && w !== '') {
      if (hasScript) operands.push(w)
      hasScript = true
    }
  }

  return operands
}

function inPlaceEdit(words: string[]): string[] | undefined {
  const name = (words[0] ?? '').split('/').at(-1)
  if (name === 'sed' && words.some(w => /^-[a-zA-Z]*i/.test(w) || w.startsWith('--in-place'))) {
    return inPlaceOperands(words, /^-[a-zA-Z]*e$|^--expression/)
  }
  if (name === 'perl' && words.some(w => /^-[a-zA-Z0-9]*i/.test(w))) {
    return inPlaceOperands(words, /^-[a-zA-Z0-9]*[eE]$/)
  }
  if ((name === 'awk' || name === 'gawk') && words.includes('inplace')) return words.slice(-1)
  if ((name === 'ed' || name === 'ex') && words.length > 1) return words.slice(1).filter(w => !w.startsWith('-'))

  return undefined
}

export function classify(command: string, context: Context): Verdict {
  if (context.extraAllowed?.test(command)) return { kind: 'allow' }

  const segments = parse(command)
  const vars = new Map<string, string>()
  let cwd = context.cwd
  const found: Found[] = []
  const isLooping = segments.some(
    s => ['for', 'while', 'until'].includes(s.words[0] ?? '') || s.words.includes('xargs') || s.words.includes('-exec'),
  )

  // Unresolved `$vars` stay as written so a loop's `"$f"` still counts as a write.
  const guarded = (operands: string[], keepUnresolved: boolean) =>
    operands.flatMap(operand => {
      const expanded = operand.includes('$') ? expand(operand, vars) : operand
      if (expanded === undefined) return keepUnresolved ? [operand] : []
      const path = resolve(expanded, cwd)
      return isTempPath(path) ? [] : [path]
    })

  for (const segment of segments) {
    const set = assignments(segment.words)
    if (set.length > 0 && segment.redirects.length === 0) {
      for (const [name, value] of set) vars.set(name, value)
      continue
    }

    const words = commandWords(segment.words)
    const name = (words[0] ?? '').split('/').at(-1) ?? ''

    if (name === 'cd' && words[1]) {
      const next = expand(words[1], vars)
      if (next !== undefined) cwd = resolve(next, cwd)
      continue
    }

    const execAt = words.findIndex(w => w === '-exec' || w === '-execdir')
    const operands = inPlaceEdit(execAt >= 0 ? words.slice(execAt + 1) : words)
    if (operands !== undefined) {
      const targets = guarded(operands, true)
      if (operands.length === 0 || targets.length > 0) {
        found.push({ via: 'in-place', targets, isBulk: isLooping || operands.length === 0 })
      }
      continue
    }

    if (name === 'tee') {
      const targets = guarded(words.slice(1).filter(w => !w.startsWith('-')), true)
      if (targets.length > 0) found.push({ via: 'tee', targets, isBulk: isLooping })
      continue
    }

    const isAllowedWriter = ALLOWED_WRITERS.test(name) || (context.extraAllowed?.test(segment.raw) ?? false)
    const writes = segment.redirects.filter(r => r.op !== '<')
    if (writes.length > 0 && !isAllowedWriter) {
      const targets = guarded(writes.map(r => r.target), false)
      if (targets.length > 0) found.push({ via: 'redirect', targets, isBulk: isLooping })
    }

    const source = inlineSource(words, segment.heredocs)
    if (source !== undefined && WRITE_APIS.some(api => api.test(source))) {
      const literal = interpreterTargets(source).flatMap(t => {
        const expanded = t.includes('$') ? expand(t, vars) : t
        return expanded === undefined || expanded.includes('${') ? [] : [resolve(expanded, cwd)]
      })
      const targets = literal.filter(t => !isTempPath(t))
      const mentionsTemp = /\/(private\/)?tmp\/|\/var\/folders\/|scratchpad/.test(source)
      const isOnlyTemp = literal.length > 0 ? targets.length === 0 : mentionsTemp && !BULK_HINTS.test(source)
      if (!isOnlyTemp) {
        const isBulk = targets.length === 0 && (isLooping || BULK_HINTS.test(source))
        found.push({ via: 'interpreter', targets, isBulk })
      }
    }
  }

  if (found.length === 0) return { kind: 'allow' }

  const targets = [...new Set(found.flatMap(f => f.targets))].map(t => display(t, context.cwd))
  const isBulk = found.some(f => f.isBulk) || targets.length > 5 || targets.some(t => t.includes('*') || t.startsWith('$'))

  return { kind: 'write', via: found[0]!.via, targets, isBulk }
}

const HOW: Record<Via, string> = {
  interpreter: 'This script writes files from inline code',
  'in-place': 'This command edits files in place',
  redirect: 'This command writes a file through a shell redirect',
  tee: 'This command writes a file through tee',
}

export function denial(verdict: Extract<Verdict, { kind: 'write' }>): string {
  const how = HOW[verdict.via]
  const shown = verdict.targets.filter(t => !t.startsWith('$'))

  if (verdict.isBulk) {
    const list = shown.length > 0 ? ` (${shown.slice(0, 8).join(', ')}${shown.length > 8 ? ', …' : ''})` : ''
    return `shell-edit-guard: ${how}, and it is a bulk change${list}. Stop and ask the user: either change each file with Edit, or they run /edit-guard allow-once and you rerun this exact command.`
  }

  if (shown.length === 0) {
    return `shell-edit-guard: ${how}. Use Edit on each file this script writes (Read it first if you haven't this session); use Write for a new file.`
  }

  const files = shown.join(', ')
  return `shell-edit-guard: ${how}. Use Edit on ${files} instead (Read ${
    shown.length === 1 ? 'it' : 'each'
  } first if you haven't this session). For a new file, use Write on ${files}.`
}
