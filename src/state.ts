import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { join } from 'node:path'
import type { ItemKind, Side } from './core/types.js'

/**
 * The merge base: what this machine and the remote last agreed on, per item.
 *
 * cc-switch's own `updated_at` column is zero for every row, so there is no
 * trustworthy timestamp to compare. This file is what makes a real three-way
 * decision possible instead of a timestamp guess.
 */
export interface StateFile {
  schemaVersion: 1
  updatedAt: string
  items: Record<string, Side>
}

export function stateKey(kind: ItemKind, id: string): string {
  return `${kind}:${id}`
}

function empty(): StateFile {
  return { schemaVersion: 1, updatedAt: new Date(0).toISOString(), items: {} }
}

export async function loadState(dir: string): Promise<StateFile> {
  const text = await readFile(join(dir, 'state.json'), 'utf8').catch(() => null)
  if (text === null) return empty()
  try {
    const parsed = JSON.parse(text) as StateFile
    if (parsed.schemaVersion !== 1 || parsed.items === null || typeof parsed.items !== 'object') {
      return empty()
    }
    return parsed
  } catch {
    // A damaged base is equivalent to no base: every item re-resolves as a
    // fresh comparison. That can only produce more conflicts, never a silent
    // overwrite, so falling back is safe where refusing to run would not be.
    return empty()
  }
}

export async function saveState(dir: string, s: StateFile): Promise<void> {
  await mkdir(dir, { recursive: true })
  s.updatedAt = new Date().toISOString()
  const tmp = join(dir, 'state.json.tmp')
  await writeFile(tmp, JSON.stringify(s, null, 2) + '\n')
  await rename(tmp, join(dir, 'state.json'))
}

export function setBase(
  s: StateFile, kind: ItemKind, id: string, side: Side | undefined,
): void {
  const k = stateKey(kind, id)
  if (side === undefined) {
    delete s.items[k]
    return
  }
  // payload is transient data for the current run; it must never be persisted
  // into the base, where it would bloat the file and could go stale.
  s.items[k] = { contentHash: side.contentHash, apps: side.apps }
}
