import { readdir, stat, lstat, mkdir, copyFile, readlink, realpath } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import type { Stats } from 'node:fs'

export const IGNORED = new Set(['.DS_Store', '.git', 'node_modules', '__pycache__'])

function isIgnored(name: string): boolean {
  return IGNORED.has(name) || name.endsWith('.pyc')
}

export interface WalkEntry { abs: string; rel: string; mode: number }

// A directory is skipped only when its real path already appears on the path
// we took to reach it — that is what a cycle is. Two different symlinks to the
// same real directory are not a cycle, and both are hashed; skipping the second
// would silently drop its content from the hash.
export async function* walk(
  dir: string, base = dir, ancestors: readonly string[] = [],
): AsyncGenerator<WalkEntry> {
  const real = await realpath(dir).catch(() => dir)
  if (ancestors.includes(real)) return
  const chain = [...ancestors, real]

  const entries = await readdir(dir, { withFileTypes: true })
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (isIgnored(e.name)) continue
    const abs = join(dir, e.name)

    let st: Stats
    try {
      st = await stat(abs)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      // A dangling symlink or an entry that vanished mid-walk is not content.
      // Anything else — a permission error, a failing disk — must not be
      // silently dropped from the hash.
      if (code === 'ENOENT' || code === 'ELOOP') continue
      throw err
    }

    if (st.isDirectory()) {
      yield* walk(abs, base, chain)
    } else if (st.isFile()) {
      yield { abs, rel: relative(base, abs).split(sep).join('/'), mode: st.mode }
    }
  }
}

export async function copyTree(src: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true })
  for await (const e of walk(src)) {
    const target = join(dest, e.rel)
    await mkdir(join(target, '..'), { recursive: true })
    await copyFile(e.abs, target)
  }
}

export async function isSymlink(p: string): Promise<boolean> {
  const st = await lstat(p).catch(() => null)
  return st !== null && st.isSymbolicLink()
}

export async function resolveLink(p: string): Promise<string> {
  return readlink(p)
}
