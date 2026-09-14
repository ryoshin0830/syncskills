export type ItemKind = 'skill' | 'mcp' | 'repo'

export type App = 'claude' | 'codex' | 'gemini' | 'opencode' | 'hermes' | 'grokbuild'

export const APPS: readonly App[] = ['claude', 'codex', 'gemini', 'opencode', 'hermes', 'grokbuild']

export interface Item {
  kind: ItemKind
  id: string
  contentHash: string
  apps: App[]
  payload?: unknown
}
