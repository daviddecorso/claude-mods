import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { PendingItem, QueueItem } from '../types'
import { ITEM_FILE, firstLineOf, joinBatch, keptItems, nextSeq, slugify, toItem, truncate } from './queue'

type $ = EngineInterface

const PANE = 'aq'

const items = atom({ plugin: 'aq', key: 'items' } as const, [] as QueueItem[])
const selected = atom({ plugin: 'aq', key: 'selected' } as const, [] as string[])
const pending = atom({ plugin: 'aq', key: 'pending' } as const, [] as PendingItem[])
const repo = atom({ plugin: 'aq', key: 'repo' } as const, '')

let queueDir = ''
let lastNudged = 0

async function logEvent($: $, event: Record<string, unknown>) {
  try {
    const home = await $.env.get('HOME')
    const line = JSON.stringify({ at: new Date().toISOString(), session: await $.session.id(), queue: queueDir, ...event })
    await $.process.run(
      ['/bin/sh', '-c', 'mkdir -p "$(dirname "$1")" && cat >> "$1"', 'sh', `${home}/.claude/mod-logs/aq.jsonl`],
      { stdin: `${line}\n` },
    )
  } catch {
    // Logging is best effort.
  }
}

function text(body: string, isError = false) {
  return { result: { content: [{ type: 'text' as const, text: body }], isError } }
}

// Same rule as the zsh `aq`: the queue sits beside the git common dir, so worktrees share it.
async function resolveQueue($: $) {
  const common = await $.process.run(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd: await $.session.cwd(),
  })
  if (common.exitCode !== 0) {
    queueDir = ''
    await update($, repo, () => '')
    return
  }
  const root = common.stdout.trim().replace(/\/+$/, '').replace(/\/[^/]+$/, '')
  queueDir = `${root}/.queue`
  await update($, repo, () => root.split('/').pop() ?? '')
}

async function queuedFiles($: $): Promise<string[]> {
  if (!queueDir || !(await $.fs.exists(queueDir))) return []
  const entries = await $.fs.list(queueDir)
  return entries
    .filter(entry => entry.kind === 'file' && ITEM_FILE.test(entry.name))
    .map(entry => entry.name)
    .sort()
}

async function refresh($: $) {
  await resolveQueue($)
  const files = await queuedFiles($)
  const loaded: QueueItem[] = []
  for (const file of files) {
    try {
      loaded.push(toItem(file, await $.fs.read(`${queueDir}/${file}`)))
    } catch {
      // Gone between list and read: `aq next` ran in another shell.
    }
  }
  await update($, items, () => loaded)
  await update($, selected, list => list.filter(file => files.includes(file)))
  return loaded
}

async function add($: $, body: string, source: string): Promise<string> {
  await resolveQueue($)
  if (!queueDir) throw new Error('not inside a git repo')
  const trimmed = body.trim()
  if (!trimmed) throw new Error('nothing to queue')

  const existing = (await $.fs.exists(queueDir)) ? (await $.fs.list(queueDir)).map(entry => entry.name) : []
  const file = `${nextSeq(existing)}-${slugify(trimmed)}.md`
  await $.fs.write(`${queueDir}/${file}`, `${trimmed}\n`)
  void logEvent($, { event: 'add', source, file })
  await refresh($)
  return file
}

async function archive($: $, files: readonly string[]) {
  if (!queueDir || files.length === 0) return
  await $.process.run(['mkdir', '-p', `${queueDir}/done`])
  await $.process.run(['mv', ...files.map(file => `${queueDir}/${file}`), `${queueDir}/done/`])
  void logEvent($, { event: 'archive', files })
  await refresh($)
}

async function fillSelected($: $) {
  const picked = await read($, selected)
  const queued = (await read($, items)).filter(item => picked.includes(item.file))
  if (queued.length === 0) {
    $.ui.toast('Nothing selected')
    return
  }

  const bodies: string[] = []
  const nextPending: PendingItem[] = []
  for (const item of queued) {
    const body = await $.fs.read(`${queueDir}/${item.file}`)
    bodies.push(body)
    nextPending.push({ file: item.file, firstLine: firstLineOf(body) })
  }

  const filled = await $.prompt.fill({ text: joinBatch(bodies), mode: 'replace' })
  if (!filled.isFilled) {
    $.ui.toast('Could not fill the prompt box')
    return
  }
  await update($, pending, () => nextPending)
  await update($, selected, () => [])
  void logEvent($, { event: 'fill', files: nextPending.map(item => item.file) })
  await $.ui.close({ id: PANE })
}

async function queueDraft($: $): Promise<string> {
  const { text: draft } = await $.prompt.read()
  if (!draft.trim()) return 'Prompt box is empty.'
  const file = await add($, draft, 'draft')
  await $.prompt.fill({ text: '', mode: 'replace' })
  return `Queued ${file}`
}

async function listing($: $): Promise<string> {
  const queued = await refresh($)
  if (!queueDir) return 'Not inside a git repo.'
  if (queued.length === 0) return 'Queue empty.'
  return queued.map(item => `${item.seq}  ${item.title}`).join('\n')
}

async function openPane($: $) {
  await refresh($)
  await $.ui.open({ id: PANE, title: 'aq', focus: true })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'aq',
      description: 'Prompt queue: open the picker, list, or add <text> (no text queues the prompt box draft)',
      argumentHint: '[ls | add [text]]',
    })
    await $.tool.register({
      name: 'aq_add',
      description:
        "Queues a prompt in this repo's aq queue (<repo>/.queue) for a later session; returns the file name. Use when the user asks to queue, park or defer something for later, or to record an out-of-scope follow-up you'd otherwise suggest at the end. Never use it to put off work the user asked for now. Write the prompt self-contained: a later session reads it with no memory of this one.",
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string', description: 'The prompt. First line is its title in the queue.' } },
        required: ['text'],
      },
    })
    await refresh($)
    return started
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    const count = (await refresh($)).length
    if (count > 0 && count !== lastNudged) $.ui.toast(`${count} queued: /aq to pick`)
    lastNudged = count
    return done
  })

  on('prompt.submit', async ($, e, next) => {
    const waiting = await read($, pending)
    const origin = e.origin?.kind
    if (waiting.length === 0 || (origin !== 'composer' && origin !== 'bridge')) return next(e)

    const kept = keptItems(e.text, waiting)
    const entered = await next(e)
    const dropped = typeof entered.drop === 'string'
    await update($, pending, () => [])
    void logEvent($, { event: 'submit', origin, dropped, waiting: waiting.map(item => item.file), kept })
    if (!dropped) await archive($, kept)
    return entered
  }).catch(($, e, next) => {
    void logEvent($, { event: 'submit-error', origin: e.origin?.kind })
    return next(e)
  })

  on('tool.call', { tool: 'mcp__aq__aq_add' }, async ($, e) => {
    try {
      const file = await add($, String(e.text ?? ''), 'model')
      return text(`Queued ${file}`)
    } catch (error) {
      return text(`aq_add failed: ${(error as Error).message}`, true)
    }
  }).catch(() => text('aq_add failed', true))

  on('command.run', { command: 'aq' }, async ($, e) => {
    const args = e.args.trim()
    const [verb = ''] = args.split(/\s+/, 1)

    if (verb === 'ls' || verb === 'l') return { text: await listing($) }
    if (verb === 'add' || verb === 'a') {
      const body = args.slice(verb.length).trim()
      try {
        return { text: body ? `Queued ${await add($, body, 'command')}` : await queueDraft($) }
      } catch (error) {
        return { text: `aq: ${(error as Error).message}` }
      }
    }
    if (verb) return { text: 'Usage: /aq [ls | add [text]]' }

    await openPane($)
    return { text: queueDir ? 'aq picker opened.' : 'Not inside a git repo.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const queued = await read($, items)
    const name = await read($, repo)
    if (!name || queued.length === 0 || e.props.hasSurvey) return next(e)

    const { Box, Text, Button } = $.ui.resolve(e)
    return (
      <Box flexDirection="row" gap={1}>
        <Text color="suggestion" bold>
          ⏵ {queued.length} queued
        </Text>
        <Button key="open" label="Open" plain dimColor onPress={() => void openPane($)} />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const queued = await read($, items)
    const picked = await read($, selected)
    const name = await read($, repo)
    const width = Math.max(20, (e.viewport?.columns ?? 80) - 8)

    const toggle = (file: string) =>
      void update($, selected, list => (list.includes(file) ? list.filter(f => f !== file) : [...list, file]))
    const toggleAll = () =>
      void update($, selected, list => (list.length === queued.length ? [] : queued.map(item => item.file)))
    const addDraft = async () => $.ui.toast(await queueDraft($).catch(error => `aq: ${(error as Error).message}`))

    if (!name) return <Text dimColor>Not inside a git repo.</Text>

    return (
      <Box flexDirection="column">
        <Text dimColor>
          {name} · {queued.length} queued{picked.length > 0 ? ` · ${picked.length} selected` : ''}
        </Text>
        {queued.length === 0 && <Text dimColor>Queue empty. /aq add &lt;text&gt;, or d to queue the prompt box.</Text>}
        {queued.map((item, index) => (
          <Box flexDirection="column">
            <Button
              key={`toggle-${item.file}`}
              label={truncate(`${picked.includes(item.file) ? '[x]' : '[ ]'} ${item.seq}  ${item.title}`, width)}
              hotkey={index < 9 ? String(index + 1) : undefined}
              plain
              onPress={() => toggle(item.file)}
            />
            {item.preview && <Text dimColor>{truncate(`      ${item.preview}`, width)}</Text>}
          </Box>
        ))}
        <Box flexDirection="row" gap={2} marginTop={1}>
          <Button
            key="fill"
            label={`Fill prompt (${picked.length})`}
            hotkey="f"
            variant="primary"
            onPress={() => void fillSelected($)}
          />
          {queued.length > 0 && (
            <Button
              key="all"
              label={picked.length === queued.length ? 'None' : 'All'}
              hotkey="a"
              onPress={toggleAll}
            />
          )}
          <Button key="draft" label="Add draft" hotkey="d" onPress={() => void addDraft()} />
          <Button key="refresh" label="Refresh" hotkey="r" onPress={() => void refresh($)} />
        </Box>
      </Box>
    )
  })
}
