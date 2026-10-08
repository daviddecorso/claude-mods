export type ServiceStatus = 'stopped' | 'starting' | 'running' | 'crashed' | 'blocked'

export type ServiceView = {
  name: string
  status: ServiceStatus
  port: number | null
  url: string | null
  pid: number | null
  note: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'dev-servers': {
      services: ServiceView[]
      selected: string
      tail: string[]
    }
  }
}
