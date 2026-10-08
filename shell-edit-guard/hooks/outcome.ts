export type Outcome = 'edit-same-file' | 'edit-other-file' | 'shell-retry' | 'bash-other' | 'other' | 'turn-ended'

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

// What the model did with the tool call right after a block: the signal for whether the block message works.
export function afterBlock(targets: readonly string[], tool: string, path: unknown, isShellWrite: boolean): Outcome {
  if (EDIT_TOOLS.has(tool)) {
    const file = typeof path === 'string' ? path : ''
    return targets.some(t => file === t || file.endsWith(`/${t}`)) ? 'edit-same-file' : 'edit-other-file'
  }
  if (tool === 'Bash') return isShellWrite ? 'shell-retry' : 'bash-other'

  return 'other'
}
