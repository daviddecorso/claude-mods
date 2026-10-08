export type DenyCount = number

declare module 'claude-code' {
  interface PluginState {
    'shell-edit-guard': {
      isOff: boolean
      isAllowedOnce: boolean
      deniesThisTurn: DenyCount
    }
  }
}
