import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { walk } from '../util/fs.js'

// Injective over the JSON value space. Anything outside it throws rather than
// collapsing to a shared encoding: a silent collision here would make two
// different configs look identical and cost the user an edit.
export function canonicalize(value: unknown): string {
  if (value === null) return 'null'

  const t = typeof value
  if (t === 'boolean' || t === 'string') return JSON.stringify(value)
  if (t === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(
        `cannot hash the non-finite number ${String(value)}: JSON cannot represent it, ` +
        `and every non-finite value would otherwise encode as null`,
      )
    }
    return JSON.stringify(value)
  }
  if (t !== 'object') {
    throw new Error(`cannot hash a value of type ${t}`)
  }

  if (Array.isArray(value)) {
    // Parsed JSON arrays never contain undefined; encode it as null if one
    // reaches us, matching JSON.stringify.
    return `[${value.map((v) => (v === undefined ? 'null' : canonicalize(v))).join(',')}]`
  }

  const proto = Object.getPrototypeOf(value) as object | null
  if (proto !== Object.prototype && proto !== null) {
    const name = (value as { constructor?: { name?: string } }).constructor?.name ?? 'non-plain'
    throw new Error(
      `cannot hash a ${name} instance: only plain JSON objects are hashable, and ` +
      `a class instance would encode as {} alongside every other one`,
    )
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`)
  return `{${entries.join(',')}}`
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
