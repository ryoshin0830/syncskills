import { describe, it, expect } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadDatabaseSync } from '../../src/util/sqlite.js'

describe('loadDatabaseSync', () => {
  it('returns a usable DatabaseSync constructor on a supported runtime', () => {
    const DatabaseSync = loadDatabaseSync()
    const db = new DatabaseSync(':memory:')
    db.exec('CREATE TABLE t (a TEXT)')
    db.prepare('INSERT INTO t VALUES (?)').run('x')
    expect(db.prepare('SELECT a FROM t').all()).toEqual([{ a: 'x' }])
    db.close()
  })

  it('caches the constructor rather than re-requiring on every call', () => {
    expect(loadDatabaseSync()).toBe(loadDatabaseSync())
  })

  it('honours readOnly, so a reader can never write to the user database', async () => {
    const DatabaseSync = loadDatabaseSync()
    const dir = await mkdtemp(join(tmpdir(), 'ss-sqlite-'))
    const file = join(dir, 'x.db')
    const w = new DatabaseSync(file)
    w.exec('CREATE TABLE t (a TEXT)')
    w.close()

    const r = new DatabaseSync(file, { readOnly: true })
    expect(() => r.exec('CREATE TABLE u (a TEXT)')).toThrow(/readonly/i)
    r.close()
  })
})
