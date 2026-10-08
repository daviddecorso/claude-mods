export type Redirect = { op: string; target: string }

export type Segment = {
  words: string[]
  redirects: Redirect[]
  heredocs: string[]
  raw: string
}

const SEPARATORS = new Set([';', '&', '|', '\n'])

// A lexer good enough to find commands, their words, redirects and heredoc bodies; it does not expand anything.
export function parse(command: string): Segment[] {
  const segments: Segment[] = []
  const pendingHeredocs: { delimiter: string; stripTabs: boolean; into: string[] }[] = []

  let words: string[] = []
  let redirects: Redirect[] = []
  let heredocs: string[] = []
  let word = ''
  let hasWord = false
  let pendingRedirect: string | undefined
  let segmentStart = 0
  let i = 0

  const endWord = () => {
    if (!hasWord) return
    if (pendingRedirect !== undefined) {
      redirects.push({ op: pendingRedirect, target: word })
      pendingRedirect = undefined
    } else {
      words.push(word)
    }
    word = ''
    hasWord = false
  }

  const endSegment = (end: number) => {
    endWord()
    if (words.length > 0 || redirects.length > 0) {
      segments.push({ words, redirects, heredocs, raw: command.slice(segmentStart, end).trim() })
    }
    words = []
    redirects = []
    heredocs = []
    pendingRedirect = undefined
  }

  const readHeredocBodies = () => {
    for (const { delimiter, stripTabs, into } of pendingHeredocs) {
      const lines: string[] = []
      while (i < command.length) {
        const lineEnd = command.indexOf('\n', i)
        const line = command.slice(i, lineEnd === -1 ? command.length : lineEnd)
        i = lineEnd === -1 ? command.length : lineEnd + 1
        if ((stripTabs ? line.replace(/^\t+/, '') : line) === delimiter) break
        lines.push(line)
      }
      into.push(lines.join('\n'))
    }
    pendingHeredocs.length = 0
  }

  while (i < command.length) {
    const c = command[i]!

    if (c === '\\' && i + 1 < command.length) {
      if (command[i + 1] !== '\n') word += command[i + 1]
      hasWord = true
      i += 2
      continue
    }

    if (c === "'") {
      const close = command.indexOf("'", i + 1)
      const end = close === -1 ? command.length : close
      word += command.slice(i + 1, end)
      hasWord = true
      i = end + 1
      continue
    }

    if (c === '"') {
      i += 1
      while (i < command.length && command[i] !== '"') {
        if (command[i] === '\\' && i + 1 < command.length) {
          word += command[i + 1]
          i += 2
        } else {
          word += command[i]
          i += 1
        }
      }
      hasWord = true
      i += 1
      continue
    }

    if (c === '$' && command[i + 1] === '(') {
      let depth = 0
      const start = i
      while (i < command.length) {
        if (command[i] === '(') depth += 1
        if (command[i] === ')') {
          depth -= 1
          if (depth === 0) break
        }
        i += 1
      }
      word += command.slice(start, i + 1)
      hasWord = true
      i += 1
      continue
    }

    if (c === '`') {
      const close = command.indexOf('`', i + 1)
      const end = close === -1 ? command.length : close
      word += command.slice(i, end + 1)
      hasWord = true
      i = end + 1
      continue
    }

    if (c === '#' && !hasWord) {
      const lineEnd = command.indexOf('\n', i)
      i = lineEnd === -1 ? command.length : lineEnd
      continue
    }

    if (c === '<' && command[i + 1] === '<' && command[i + 2] !== '<') {
      endWord()
      i += 2
      const stripTabs = command[i] === '-'
      if (stripTabs) i += 1
      while (command[i] === ' ' || command[i] === '\t') i += 1
      const match = /^(['"]?)([A-Za-z0-9_.-]+)\1/.exec(command.slice(i))
      if (match) {
        pendingHeredocs.push({ delimiter: match[2]!, stripTabs, into: heredocs })
        i += match[0].length
      }
      continue
    }

    if (c === '>' || (c === '&' && command[i + 1] === '>')) {
      const fdPrefix = /^\d+$/.test(word) ? word : ''
      if (fdPrefix) {
        word = ''
        hasWord = false
      } else {
        endWord()
      }
      let op = c === '&' ? '&>' : '>'
      i += c === '&' ? 2 : 1
      if (command[i] === '>') {
        op += '>'
        i += 1
      } else if (command[i] === '|') {
        i += 1
      }
      if (command[i] === '&') {
        i += 1
        while (/[0-9-]/.test(command[i] ?? '')) i += 1
        continue
      }
      pendingRedirect = fdPrefix + op
      continue
    }

    if (c === '<') {
      endWord()
      pendingRedirect = '<'
      i += 1
      continue
    }

    if (SEPARATORS.has(c)) {
      endSegment(i)
      i += 1
      if ((c === '&' || c === '|') && command[i] === c) i += 1
      if (c === '\n' && pendingHeredocs.length > 0) readHeredocBodies()
      segmentStart = i
      continue
    }

    if (c === ' ' || c === '\t' || c === '\r') {
      endWord()
      i += 1
      continue
    }

    if ((c === '(' || c === ')' || c === '{' || c === '}') && !hasWord) {
      i += 1
      continue
    }

    word += c
    hasWord = true
    i += 1
  }

  endSegment(command.length)
  if (pendingHeredocs.length > 0) readHeredocBodies()

  return segments
}

const WRAPPERS = new Set(['command', 'builtin', 'exec', 'nohup', 'time', 'sudo', 'nice'])

// Skips `VAR=x`, wrappers (`env`, `nohup`, `xargs -n1`, `rtk proxy`) and keywords to reach the command that runs.
export function commandWords(words: string[]): string[] {
  let i = 0
  while (i < words.length) {
    const w = words[i]!
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) {
      i += 1
    } else if (WRAPPERS.has(w) || ['then', 'do', 'else', '!'].includes(w)) {
      i += 1
    } else if (w === 'env') {
      i += 1
      while (i < words.length && (words[i]!.startsWith('-') || words[i]!.includes('='))) i += 1
    } else if (w === 'xargs') {
      i += 1
      while (i < words.length && words[i]!.startsWith('-')) {
        i += /^-[IJLnPsE]$/.test(words[i]!) ? 2 : 1
      }
    } else if (w === 'rtk' && words[i + 1] === 'proxy') {
      i += 2
    } else {
      break
    }
  }

  return words.slice(i)
}

export function assignments(words: string[]): [string, string][] {
  const found: [string, string][] = []
  for (const w of words[0] === 'export' ? words.slice(1) : words) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(w)
    if (!match) return []
    found.push([match[1]!, match[2]!])
  }

  return found
}

export function expand(text: string, vars: ReadonlyMap<string, string>): string | undefined {
  let isResolved = true
  const out = text.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (_, name: string) => {
    const value = vars.get(name)
    if (value === undefined) isResolved = false
    return value ?? ''
  })

  return isResolved ? out : undefined
}
