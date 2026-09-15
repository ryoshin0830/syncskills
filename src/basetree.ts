import { rm, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
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
 */
export function baseTreeDir(configDir: string, kind: ItemKind, id: string): string {
  return join(configDir, 'base', kind, id)
}

export async function saveBaseTree(
  configDir: string, kind: ItemKind, id: string, src: string,
): Promise<void> {
  const dest = baseTreeDir(configDir, kind, id)
  await rm(dest, { recursive: true, force: true })
  if (!existsSync(src)) return
  await mkdir(dest, { recursive: true })
  await copyTree(src, dest)
}

export async function dropBaseTree(
  configDir: string, kind: ItemKind, id: string,
): Promise<void> {
  await rm(baseTreeDir(configDir, kind, id), { recursive: true, force: true })
}

/** The base tree for an item, or undefined when none was ever recorded. */
export function existingBaseTree(
  configDir: string, kind: ItemKind, id: string,
): string | undefined {
  const dir = baseTreeDir(configDir, kind, id)
  return existsSync(dir) ? dir : undefined
}
