import { readdir, stat, lstat, mkdir, copyFile, readlink } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

export const IGNORED = new Set(['.DS_Store', '.git', 'node_modules', '__pycache__'])

function isIgnored(name: string): boolean {
  return IGNORED.has(name) || name.endsWith('.pyc')
}

export interface WalkEntry { abs: string; rel: string; mode: number }

export async function* walk(dir: string, base = dir): AsyncGenerator<WalkEntry> {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (isIgnored(e.name)) continue
    const abs = join(dir, e.name)
    const st = await stat(abs).catch(() => null)
    if (st === null) continue
    if (st.isDirectory()) {
      yield* walk(abs, base)
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
