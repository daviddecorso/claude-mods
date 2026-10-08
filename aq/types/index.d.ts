export type QueueItem = {
  file: string
  seq: string
  title: string
  preview: string
}

export type PendingItem = {
  file: string
  firstLine: string
}

declare module 'claude-code' {
  interface PluginState {
    aq: {
      items: QueueItem[]
      selected: string[]
      pending: PendingItem[]
      repo: string
    }
  }
}
