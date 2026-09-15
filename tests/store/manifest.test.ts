import { describe, it, expect } from 'vitest'
import {
  emptyManifest, parseManifest, serializeManifest, manifestSides, upsertEntry, removeEntry,
  unsafeManifestIds,
} from '../../src/store/manifest.js'

describe('manifest', () => {
  it('serializes deterministically so an unchanged sync produces no git diff', () => {
    const a = emptyManifest()
    upsertEntry(a, 'skill', 'b', { contentHash: 'sha256:1', apps: ['claude'] }, 'dev')
    upsertEntry(a, 'skill', 'a', { contentHash: 'sha256:2', apps: ['codex'] }, 'dev')
    const first = serializeManifest(a)
    expect(serializeManifest(parseManifest(first))).toBe(first)
  })

  it('writes entry keys in sorted order', () => {
    const m = emptyManifest()
    upsertEntry(m, 'skill', 'z', { contentHash: 'sha256:1', apps: [] }, 'dev')
    upsertEntry(m, 'mcp', 'a', { contentHash: 'sha256:2', apps: [] }, 'dev')
    const keys = Object.keys((JSON.parse(serializeManifest(m)) as { entries: object }).entries)
    expect(keys).toEqual([...keys].sort())
  })

  it('starts a new entry at version 1', () => {
    const m = emptyManifest()
    upsertEntry(m, 'skill', 'a', { contentHash: 'sha256:1', apps: [] }, 'dev')
    expect(m.entries['skill:a']!.version).toBe(1)
  })

  it('increments the version when the content changes', () => {
    const m = emptyManifest()
    upsertEntry(m, 'skill', 'a', { contentHash: 'sha256:1', apps: [] }, 'dev')
    upsertEntry(m, 'skill', 'a', { contentHash: 'sha256:2', apps: [] }, 'dev')
    expect(m.entries['skill:a']!.version).toBe(2)
  })

  it('increments the version when only the app matrix changes', () => {
    const m = emptyManifest()
    upsertEntry(m, 'skill', 'a', { contentHash: 'sha256:1', apps: [] }, 'dev')
    upsertEntry(m, 'skill', 'a', { contentHash: 'sha256:1', apps: ['claude'] }, 'dev')
    expect(m.entries['skill:a']!.version).toBe(2)
  })

  it('leaves the version and timestamp alone when nothing changed', () => {
    const m = emptyManifest()
    upsertEntry(m, 'skill', 'a', { contentHash: 'sha256:1', apps: [] }, 'dev')
    const before = { ...m.entries['skill:a']! }
    upsertEntry(m, 'skill', 'a', { contentHash: 'sha256:1', apps: [] }, 'other-device')
    expect(m.entries['skill:a']).toEqual(before)
  })

  it('records the device that made the change', () => {
    const m = emptyManifest()
    upsertEntry(m, 'skill', 'a', { contentHash: 'sha256:1', apps: [] }, 'home-mac')
    expect(m.entries['skill:a']!.updatedBy).toBe('home-mac')
  })

  it('never writes payload into the manifest', () => {
    const m = emptyManifest()
    upsertEntry(m, 'mcp', 'o', {
      contentHash: 'sha256:1', apps: [], payload: { env: { K: 'sk-secret' } },
    }, 'dev')
    expect(serializeManifest(m)).not.toContain('sk-secret')
  })

  it('projects sides for one kind only', () => {
    const m = emptyManifest()
    upsertEntry(m, 'skill', 'a', { contentHash: 'sha256:1', apps: ['claude'] }, 'dev')
    upsertEntry(m, 'mcp', 'b', { contentHash: 'sha256:2', apps: [] }, 'dev')
    const sides = manifestSides(m, 'skill')
    expect([...sides.keys()]).toEqual(['a'])
    expect(sides.get('a')).toEqual({ contentHash: 'sha256:1', apps: ['claude'] })
  })

  it('keeps a skill and an mcp with the same id apart', () => {
    const m = emptyManifest()
    upsertEntry(m, 'skill', 'x', { contentHash: 'sha256:s', apps: [] }, 'dev')
    upsertEntry(m, 'mcp', 'x', { contentHash: 'sha256:m', apps: [] }, 'dev')
    expect(manifestSides(m, 'skill').get('x')!.contentHash).toBe('sha256:s')
    expect(manifestSides(m, 'mcp').get('x')!.contentHash).toBe('sha256:m')
  })

  it('carries no generated-at stamp, so a no-op sync produces no commit', () => {
    const m = emptyManifest()
    upsertEntry(m, 'skill', 'a', { contentHash: 'sha256:1', apps: [] }, 'dev')
    const first = serializeManifest(m)
    const second = serializeManifest(parseManifest(first))
    expect(second).toBe(first)
    expect(first).not.toMatch(/generatedAt/)
  })

  it('removes an entry', () => {
    const m = emptyManifest()
    upsertEntry(m, 'skill', 'a', { contentHash: 'sha256:1', apps: [] }, 'dev')
    removeEntry(m, 'skill', 'a')
    expect(m.entries['skill:a']).toBeUndefined()
  })

  it('treats an unparsable manifest as a hard error, never as empty', () => {
    expect(() => parseManifest('{ broken')).toThrow(/manifest\.json is not valid JSON/)
  })

  it('rejects an unknown schema version', () => {
    expect(() => parseManifest(JSON.stringify({ schemaVersion: 2, entries: {} })))
      .toThrow(/schema version/i)
  })

  it('rejects a manifest with no entries object', () => {
    expect(() => parseManifest(JSON.stringify({ schemaVersion: 1 })))
      .toThrow(/no entries object/)
  })
})

describe('untrusted ids from the remote', () => {
  const evil = (id: string, kind: 'skill' | 'repo' = 'skill') => {
    const m = emptyManifest()
    m.entries[`${kind}:${id}`] = {
      kind, id, contentHash: 'sha256:x', apps: [], version: 1,
      updatedAt: '2026-01-01T00:00:00.000Z', updatedBy: 'attacker',
    }
    return m
  }

  it('drops an id that climbs out of the skills directory', () => {
    for (const id of ['../escape', 'a/../../b', '..', '.', 'a/b', '/abs', 'x\\\\y']) {
      expect(manifestSides(evil(id), 'skill').size, id).toBe(0)
    }
  })

  it('drops a hidden-directory id', () => {
    expect(manifestSides(evil('.git'), 'skill').size).toBe(0)
    expect(manifestSides(evil('.ssh'), 'skill').size).toBe(0)
  })

  it('keeps an ordinary skill id', () => {
    expect(manifestSides(evil('code-review'), 'skill').size).toBe(1)
  })

  it('allows exactly one slash for a repository and no more', () => {
    expect(manifestSides(evil('owner/name', 'repo'), 'repo').size).toBe(1)
    expect(manifestSides(evil('owner/../name', 'repo'), 'repo').size).toBe(0)
    expect(manifestSides(evil('a/b/c', 'repo'), 'repo').size).toBe(0)
  })

  it('reports what it refused rather than hiding it', () => {
    expect(unsafeManifestIds(evil('../escape'))).toEqual(['skill:../escape'])
  })
})
