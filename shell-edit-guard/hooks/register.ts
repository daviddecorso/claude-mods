import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { classify, denial } from './classify'
import { afterBlock, type Outcome } from './outcome'

type $ = EngineInterface

const isOff = atom({ plugin: 'shell-edit-guard', key: 'isOff' } as const, false)
const isAllowedOnce = atom({ plugin: 'shell-edit-guard', key: 'isAllowedOnce' } as const, false)
const deniesThisTurn = atom({ plugin: 'shell-edit-guard', key: 'deniesThisTurn' } as const, 0)

const RETRY_LIMIT = 3

// The last block still waiting to see what the model does next; per loop, so a subagent's calls don't settle the main loop's.
let pending: { targets: string[]; agentId: string | undefined } | undefined

function compile(pattern: unknown): RegExp | undefined {
  if (typeof pattern !== 'string' || pattern.trim() === '') return undefined
  try {
    return new RegExp(pattern)
  } catch {
    return undefined
  }
}

// Appends one line to ~/.claude/mod-logs/shell-edit-guard.jsonl, which /mods-report reads; never fails the hook.
async function logEvent($: $, event: Record<string, unknown>) {
  try {
    const home = await $.env.get('HOME')
    const line = JSON.stringify({ at: new Date().toISOString(), session: await $.session.id(), ...event })
    await $.process.run(
      ['/bin/sh', '-c', 'mkdir -p "$(dirname "$1")" && cat >> "$1"', 'sh', `${home}/.claude/mod-logs/shell-edit-guard.jsonl`],
      { stdin: `${line}\n` },
    )
  } catch {
    // Logging is best effort.
  }
}

function settle($: $, outcome: Outcome, tool: string) {
  pending = undefined
  void logEvent($, { event: 'after-block', outcome, tool })
}

export const register: Register = (on, options) => {
  const extraAllowed = compile(options.extraAllowed)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'edit-guard',
      description: 'Shell-edit guard: off, on, allow-once, or status',
      argumentHint: '[off|on|allow-once|status]',
    })

    return next(e)
  })

  on('command.run', { command: 'edit-guard' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'off' || arg === 'on' || arg === 'allow-once') void logEvent($, { event: 'command', arg })
    if (arg === 'off') {
      await update($, isOff, () => true)
      return { text: 'Shell-edit guard is off for this session.' }
    }
    if (arg === 'on') {
      await update($, isOff, () => false)
      return { text: 'Shell-edit guard is on.' }
    }
    if (arg === 'allow-once') {
      await update($, isAllowedOnce, () => true)
      return {
        text: 'The next shell file write will run once.',
        context: ['The user ran /edit-guard allow-once: the next command that shell-edit-guard would block may run.'],
      }
    }

    const state = (await read($, isOff)) ? 'off' : 'on'
    return { text: `Shell-edit guard is ${state}. Usage: /edit-guard off | on | allow-once` }
  })

  on('turn.start', async ($, e, next) => {
    await update($, deniesThisTurn, () => 0)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (pending && pending.agentId === e.agentId) settle($, 'turn-ended', '')
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const command = e.tool === 'Bash' ? e.command : undefined
    const isGuarding = command !== undefined && !(await read($, isOff))
    const verdict = isGuarding ? classify(command, { cwd: await $.session.cwd(), extraAllowed }) : undefined
    const isShellWrite = verdict?.kind === 'write'

    if (pending && pending.agentId === e.agentId) {
      const path = 'file_path' in e ? e.file_path : 'notebook_path' in e ? e.notebook_path : undefined
      settle($, afterBlock(pending.targets, String(e.tool), path, isShellWrite), String(e.tool))
    }

    if (verdict?.kind !== 'write' || command === undefined) return next(e)

    if (await read($, isAllowedOnce)) {
      await update($, isAllowedOnce, () => false)
      void logEvent($, { event: 'allowed-once', via: verdict.via, targets: verdict.targets, command: command.slice(0, 400) })
      return next(e)
    }

    const denies = await update($, deniesThisTurn, n => n + 1)
    const isCapped = denies > RETRY_LIMIT
    pending = { targets: verdict.targets, agentId: e.agentId }
    void logEvent($, {
      event: 'block',
      via: verdict.via,
      targets: verdict.targets,
      isBulk: verdict.isBulk,
      isCapped,
      cwd: await $.session.cwd(),
      command: command.slice(0, 400),
    })
    $.ui.status(`edit-guard: blocked a shell write${verdict.targets[0] ? ` to ${verdict.targets[0]}` : ''}`)

    if (isCapped) {
      return {
        deny: 'shell-edit-guard: blocked again. Stop retrying shell writes; tell the user what you are trying to change and ask how to proceed.',
      }
    }

    return { deny: denial(verdict) }
  }).catch(($, e, next) => next(e))
}
