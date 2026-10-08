import type { PendingItem, QueueItem } from '../types'

export const ITEM_FILE = /^(\d{3})-.*\.md$/

// The separator `aq next` puts between batched prompts.
export const BATCH_SEPARATOR = '\n\n---\n\n'

// Mirrors the zsh slug: first line, lowercased, non-alnum runs to `-`, trimmed, cut to 40.
export function slugify(body: string): string {
  const firstLine = body.split('\n', 1)[0] ?? ''
  const slug = firstLine
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-/, '')
    .replace(/-$/, '')
    .slice(0, 40)
  return slug || 'task'
}

export function nextSeq(names: readonly string[]): string {
  let max = 0
  for (const name of names) {
    const match = ITEM_FILE.exec(name)
    if (match) max = Math.max(max, Number(match[1]))
  }
  return String(max + 1).padStart(3, '0')
}

export function firstLineOf(body: string): string {
  return (body.split('\n', 1)[0] ?? '').trim()
}

export function toItem(file: string, body: string): QueueItem {
  const [, rest = ''] = /^[^\n]*\n?([\s\S]*)$/.exec(body) ?? []
  return {
    file,
    seq: file.slice(0, 3),
    title: firstLineOf(body).replace(/^#*\s*/, ''),
    preview: rest.split('\n').map(line => line.trim()).filter(Boolean).join(' '),
  }
}

export function joinBatch(bodies: readonly string[]): string {
  return bodies.map(body => body.trimEnd()).join(BATCH_SEPARATOR)
}

// Items whose first line survived the person's edits, so deleting one from the draft keeps it queued.
export function keptItems(submitted: string, pending: readonly PendingItem[]): string[] {
  return pending.filter(item => item.firstLine && submitted.includes(item.firstLine)).map(item => item.file)
}

export function truncate(text: string, width: number): string {
  return text.length > width ? `${text.slice(0, Math.max(1, width - 1))}…` : text
}
