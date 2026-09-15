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

/**
 * An id becomes a path under the skills directory and inside the git working
 * copy, so anything that could climb out of either must be refused. A
 * repository id is the one shape allowed a single slash.
 */
export function isSafeItemId(kind: ItemKind, id: string): boolean {
  if (id.length === 0 || id.length > 200) return false
  if (id.startsWith('.') || id.includes('\0') || id.includes('\\')) return false

  const segments = id.split('/')
  if (kind === 'repo') {
    if (segments.length !== 2) return false
  } else if (segments.length !== 1) return false

  return segments.every((s) => s.length > 0 && s !== '.' && s !== '..' && !s.startsWith('.'))
}
