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

export type Decision =
  | 'IN_SYNC' | 'PUSH' | 'PULL' | 'PUSH_NEW' | 'PULL_NEW'
  | 'DELETE_REMOTE' | 'DELETE_LOCAL' | 'CONFLICT'

export type ConflictKind = 'both-edited' | 'both-created' | 'local-deleted' | 'remote-deleted'

export interface Side {
  contentHash: string
  apps: App[]
  /** Raw item data carried alongside the hash for later tasks; never hashed,
   *  never compared, and never allowed to influence a decision. */
  payload?: unknown
}

export interface Resolution {
  kind: ItemKind
  id: string
  decision: Decision
  conflictKind?: ConflictKind
  appsDecision: Decision
  apps: App[]
  base?: Side
  local?: Side
  remote?: Side
}
