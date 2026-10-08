const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g
const QR_LINE = /[█▀▄▌▐]{6,}/
const ERROR_LINE = /\b(error|errors|exception|failed|failure|unhandled|uncaught|cannot|ERR!|ERR_)\b|✘|✖|\[ERROR\]/i
const URL = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):\d+[^\s'"]*/

export const MAX_LINES = 2000
export const MAX_TOOL_LINES = 200

export class LogBuffer {
  lines: string[] = []
  private partial = ''

  push(text: string): string[] {
    const pieces = (this.partial + text.replace(ANSI, '').replace(/\r(?!\n)/g, '\n')).split(/\r?\n/)
    this.partial = pieces.pop() ?? ''
    const added = pieces.filter(line => !QR_LINE.test(line))
    this.lines.push(...added)
    if (this.lines.length > MAX_LINES) this.lines.splice(0, this.lines.length - MAX_LINES)

    return added
  }

  clear() {
    this.lines = []
    this.partial = ''
  }
}

export type LogQuery = {
  tail?: number
  grep?: string
  level?: 'error' | 'all'
}

export function query(lines: readonly string[], { tail = 50, grep, level = 'all' }: LogQuery): { lines: string[]; matched: number } {
  let pattern: RegExp | undefined
  if (grep) {
    try {
      pattern = new RegExp(grep, 'i')
    } catch {
      pattern = new RegExp(grep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
    }
  }

  const matching = lines.filter(
    line => line.trim() !== '' && (level !== 'error' || ERROR_LINE.test(line)) && (!pattern || pattern.test(line)),
  )
  const count = Math.max(1, Math.min(MAX_TOOL_LINES, Math.floor(tail)))

  return { lines: matching.slice(-count), matched: matching.length }
}

export function findUrl(line: string): string | undefined {
  return URL.exec(line)?.[0]?.replace(/\/$/, '')
}
