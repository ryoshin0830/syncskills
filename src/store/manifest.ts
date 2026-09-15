import { isSafeItemId } from '../core/types.js'
import type { App, ItemKind, Side } from '../core/types.js'
import { stateKey } from '../state.js'

export interface ManifestEntry {
  kind: ItemKind
  id: string
  contentHash: string
  apps: App[]
  /** Monotonic per item. Carried for humans reading the repo; the resolver
   *  never reads it — decisions come from hashes alone. */
  version: number
  updatedAt: string
  updatedBy: string
}

export interface Manifest {
  schemaVersion: 1
  entries: Record<string, ManifestEntry>
}

export function emptyManifest(): Manifest {
  return { schemaVersion: 1, entries: {} }
}

/**
 * An empty manifest and a corrupt one must never be confused. Empty means "the
 * remote holds nothing"; corrupt means "do not act". Treating the second as the
 * first would delete every item on the remote, so this throws.
 */
export function parseManifest(text: string): Manifest {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    throw new Error(`manifest.json is not valid JSON: ${(e as Error).message}`)
  }
  const m = parsed as Manifest
  if (m.schemaVersion !== 1) {
    throw new Error(`unsupported manifest schema version ${m.schemaVersion}; upgrade oneset`)
  }
  if (m.entries === null || typeof m.entries !== 'object' || Array.isArray(m.entries)) {
    throw new Error('manifest.json has no entries object')
  }
  // Every entry, not just the envelope. A half-built entry is the dangerous
  // shape: manifestSides would hand the resolver a Side whose contentHash is
  // undefined, and decide() cannot tell that from a side that is not there —
  // so one damaged entry resolves to "the remote deleted it" and erases the
  // item from every machine. Refusing the file is the only safe reading of it.
  for (const [key, e] of Object.entries(m.entries)) {
    validateEntry(key, e as unknown)
  }
  return m
}

const KINDS = new Set<string>(['skill', 'mcp', 'repo'])

function validateEntry(key: string, e: unknown): void {
  const bad = (why: string): never => {
    throw new Error(`manifest.json entry "${key}" is damaged: ${why}. Nothing was changed.`)
  }
  if (e === null || typeof e !== 'object' || Array.isArray(e)) bad('it is not an object')
  const entry = e as Partial<ManifestEntry>

  if (typeof entry.kind !== 'string' || !KINDS.has(entry.kind)) bad('kind is missing or unknown')
  if (typeof entry.id !== 'string' || entry.id === '') bad('id is missing')
  if (typeof entry.contentHash !== 'string' || entry.contentHash === '') {
    bad('contentHash is missing')
  }
  if (!Array.isArray(entry.apps) || entry.apps.some((a) => typeof a !== 'string')) {
    bad('apps is missing or is not a list of names')
  }
}

/**
 * A pure function of the entries: same entries, same bytes. There is
 * deliberately no generated-at stamp — one would change on every run and turn
 * every no-op sync into a commit, filling the history with noise.
 */
export function serializeManifest(m: Manifest): string {
  const entries: Record<string, ManifestEntry> = {}
  for (const k of Object.keys(m.entries).sort()) entries[k] = m.entries[k]!
  return JSON.stringify({ schemaVersion: 1, entries }, null, 2) + '\n'
}

export function manifestSides(m: Manifest, kind: ItemKind): Map<string, Side> {
  const out = new Map<string, Side>()
  for (const e of Object.values(m.entries)) {
    if (e.kind !== kind) continue
    // Ids from the remote are untrusted input: they become filesystem paths on
    // this machine. One that could climb out of its directory is dropped.
    if (!isSafeItemId(kind, e.id)) continue
    out.set(e.id, { contentHash: e.contentHash, apps: e.apps })
  }
  return out
}

/** Ids in the manifest that were refused as unsafe, for reporting. */
export function unsafeManifestIds(m: Manifest): string[] {
  return Object.values(m.entries)
    .filter((e) => !isSafeItemId(e.kind, e.id))
    .map((e) => `${e.kind}:${e.id}`)
    .sort()
}

export function upsertEntry(
  m: Manifest, kind: ItemKind, id: string, side: Side, device: string,
): void {
  const key = stateKey(kind, id)
  const prev = m.entries[key]
  const unchanged =
    prev !== undefined &&
    prev.contentHash === side.contentHash &&
    JSON.stringify(prev.apps) === JSON.stringify(side.apps)
  // Rewriting an unchanged entry would churn updatedAt and updatedBy on every
  // sync from every machine, filling the history with noise.
  if (unchanged) return

  m.entries[key] = {
    kind,
    id,
    contentHash: side.contentHash,
    apps: side.apps,
    version: (prev?.version ?? 0) + 1,
    updatedAt: new Date().toISOString(),
    updatedBy: device,
  }
}

export function removeEntry(m: Manifest, kind: ItemKind, id: string): void {
  delete m.entries[stateKey(kind, id)]
}
