import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { walk } from '../util/fs.js'

export function canonicalize(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`)
    return `{${entries.join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

export function canonicalJsonHash(value: unknown): string {
  return 'sha256:' + createHash('sha256').update(canonicalize(value)).digest('hex')
}

export async function treeHash(dir: string): Promise<string> {
  const st = await stat(dir)
  if (!st.isDirectory()) throw new Error(`not a directory: ${dir}`)

  const parts: string[] = []
  const entries: { rel: string; mode: number; abs: string }[] = []
  for await (const e of walk(dir)) entries.push(e)
  entries.sort((a, b) => (a.rel < b.rel ? -1 : 1))

  for (const e of entries) {
    const body = await readFile(e.abs)
    const exec = (e.mode & 0o111) !== 0 ? '1' : '0'
    parts.push(`${e.rel}\0${exec}\0${createHash('sha256').update(body).digest('hex')}\0`)
  }

  return 'sha256:' + createHash('sha256').update(parts.join('')).digest('hex')
}
