import { rm, mkdir, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { copyTree } from './util/fs.js'
import type { ItemKind } from './core/types.js'

/**
 * A copy of each skill as it stood when this machine and the remote last
 * agreed. state.json records the base HASH, which is all the resolver needs,
 * but a real three-way merge needs the base CONTENT: without it every
 * overlapping file looks like an independent creation and goes to the merge
 * agent, and a file deleted on one side cannot be told from one added on the
 * other.
 *
 * The hash and the content are ONE record kept in two places, and they are
 * written at different moments — the tree during apply, state.json only after a
 * successful push. Anything that ends a run in between leaves a tree describing
 * an agreement that never happened, and such a tree is worse than no tree: used
 * as an ancestor it reads every line the other side does not also have as
 * deliberately deleted and drops it, with no conflict reported. So each tree
 * carries the hash it was saved for, and is only offered when state.json still
 * agrees with it. That makes the pairing self-checking rather than something a
 * compensating step has to remember to undo on every possible exit.
 */
export function baseTreeDir(configDir: string, kind: ItemKind, id: string): string {
  return join(configDir, 'base', kind, id)
}

/** Beside the tree, never inside it: the tree is the item's content verbatim. */
function hashFile(configDir: string, kind: ItemKind, id: string): string {
  return `${baseTreeDir(configDir, kind, id)}.hash`
}

export async function saveBaseTree(
  configDir: string, kind: ItemKind, id: string, src: string, contentHash: string,
): Promise<void> {
  const dest = baseTreeDir(configDir, kind, id)
  await rm(dest, { recursive: true, force: true })
  await rm(hashFile(configDir, kind, id), { force: true })
  if (!existsSync(src)) return
  await mkdir(dest, { recursive: true })
  await copyTree(src, dest)
  // Last, so a run that dies mid-copy leaves a tree with no hash beside it —
  // which reads as "no base tree" rather than as a base tree that lies.
  await writeFile(hashFile(configDir, kind, id), contentHash)
}

export async function dropBaseTree(
  configDir: string, kind: ItemKind, id: string,
): Promise<void> {
  await rm(baseTreeDir(configDir, kind, id), { recursive: true, force: true })
  await rm(hashFile(configDir, kind, id), { force: true })
}

/**
 * The base tree for an item, or undefined when there is none this machine can
 * vouch for. `recordedHash` is what state.json holds for the same item.
 */
export function existingBaseTree(
  configDir: string, kind: ItemKind, id: string, recordedHash: string | undefined,
): string | undefined {
  if (recordedHash === undefined) return undefined
  const dir = baseTreeDir(configDir, kind, id)
  if (!existsSync(dir)) return undefined
  let saved: string
  try {
    saved = readFileSync(hashFile(configDir, kind, id), 'utf8').trim()
  } catch {
    return undefined
  }
  return saved === recordedHash ? dir : undefined
}
