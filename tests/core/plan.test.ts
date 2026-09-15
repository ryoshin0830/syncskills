import { describe, it, expect } from 'vitest'
import { buildPlan } from '../../src/core/plan.js'
import { resolveItem } from '../../src/core/resolve.js'
import type { Side } from '../../src/core/types.js'

const S = (h: string, apps: string[] = ['claude']): Side =>
  ({ contentHash: h, apps: apps as Side['apps'] })

const r = (id: string, base?: Side, local?: Side, remote?: Side) =>
  resolveItem({ kind: 'skill', id, base, local, remote })

describe('buildPlan', () => {
  it('drops IN_SYNC items from the action list', () => {
    expect(buildPlan([r('a', S('A'), S('A'), S('A'))]).actions).toHaveLength(0)
  })

  it('maps each decision to its action type', () => {
    const p = buildPlan([
      r('push', S('A'), S('B'), S('A')),
      r('pull', S('A'), S('A'), S('B')),
      r('new-l', undefined, S('B'), undefined),
      r('new-r', undefined, undefined, S('B')),
      r('del-r', S('A'), undefined, S('A')),
      r('del-l', S('A'), S('A'), undefined),
    ])
    expect(Object.fromEntries(p.actions.map((a) => [a.id, a.type]))).toEqual({
      push: 'push-content', pull: 'pull-content',
      'new-l': 'push-content', 'new-r': 'pull-content',
      'del-r': 'delete-remote', 'del-l': 'delete-local',
    })
  })

  it('routes conflicts to the conflicts list, not the action list', () => {
    const p = buildPlan([r('c', S('A'), S('B'), S('C'))])
    expect(p.actions).toHaveLength(0)
    expect(p.conflicts).toHaveLength(1)
    expect(p.conflicts[0]!.type).toBe('merge')
  })

  it('emits a set-apps action when only the matrix differs', () => {
    const p = buildPlan([r('m', S('A', ['claude']), S('A', ['claude', 'codex']), S('A', ['claude']))])
    expect(p.actions.map((a) => a.type)).toEqual(['set-apps'])
  })

  it('emits nothing when content and matrix both agree', () => {
    const p = buildPlan([r('m', S('A', ['claude']), S('A', ['claude']), S('A', ['claude']))])
    expect(p.actions).toHaveLength(0)
    expect(p.counts.noop).toBe(1)
  })

  it('orders pulls before pushes so a failed push cannot strand a pull', () => {
    const p = buildPlan([
      r('z-push', S('A'), S('B'), S('A')),
      r('a-pull', S('A'), S('A'), S('B')),
    ])
    expect(p.actions.map((a) => a.type)).toEqual(['pull-content', 'push-content'])
  })

  it('orders remote deletes last, after every push has been taken', () => {
    const p = buildPlan([
      r('del', S('A'), undefined, S('A')),
      r('push', S('A'), S('B'), S('A')),
      r('pull', S('A'), S('A'), S('B')),
    ])
    expect(p.actions.map((a) => a.type))
      .toEqual(['pull-content', 'push-content', 'delete-remote'])
  })

  it('counts every action type, including the zeroes', () => {
    const p = buildPlan([r('push', S('A'), S('B'), S('A'))])
    expect(p.counts['push-content']).toBe(1)
    expect(p.counts['pull-content']).toBe(0)
    expect(p.counts.merge).toBe(0)
  })

  it('produces a stable order for identical input', () => {
    const input = [r('b', S('A'), S('B'), S('A')), r('a', S('A'), S('B'), S('A'))]
    expect(buildPlan(input).actions.map((a) => a.id)).toEqual(['a', 'b'])
    expect(buildPlan(input).actions.map((a) => a.id))
      .toEqual(buildPlan(input).actions.map((a) => a.id))
  })

  it('keeps a skill and an mcp with the same id distinct in the plan', () => {
    const p = buildPlan([
      resolveItem({ kind: 'mcp', id: 'x', base: S('A'), local: S('B'), remote: S('A') }),
      resolveItem({ kind: 'skill', id: 'x', base: S('A'), local: S('B'), remote: S('A') }),
    ])
    expect(p.actions.map((a) => a.kind)).toEqual(['mcp', 'skill'])
  })
})

describe('pruneBackups', () => {
  it('keeps only the most recent backups, because each one holds credentials', async () => {
    const { pruneBackups } = await import('../../src/core/apply.js')
    const { mkdtemp, mkdir, readdir } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')

    const root = await mkdtemp(join(tmpdir(), 'ss-bk-'))
    for (let i = 0; i < 15; i++) {
      await mkdir(join(root, `2026-09-15T00-00-${String(i).padStart(2, '0')}Z`))
    }
    const removed = await pruneBackups(root, 10)
    expect(removed).toHaveLength(5)
    expect(await readdir(root)).toHaveLength(10)
  })

  it('does nothing when there are fewer than the limit', async () => {
    const { pruneBackups } = await import('../../src/core/apply.js')
    const { mkdtemp, mkdir } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const root = await mkdtemp(join(tmpdir(), 'ss-bk2-'))
    await mkdir(join(root, 'a'))
    expect(await pruneBackups(root, 10)).toEqual([])
  })
})

describe('buildPlan — items that already agree', () => {
  it('collects them so their base can be recorded', () => {
    const p = buildPlan([
      r('same', S('A'), S('A'), S('A')),
      r('push', S('A'), S('B'), S('A')),
    ])
    expect(p.inSync.map((x) => x.id)).toEqual(['same'])
  })

  it('does not collect an item that exists on neither side', () => {
    expect(buildPlan([r('gone', undefined, undefined, undefined)]).inSync).toEqual([])
  })

  it('collects an item whose content agrees even though its matrix does not', () => {
    const p = buildPlan([r('m', S('A', ['claude']), S('A', ['claude', 'codex']), S('A', ['claude']))])
    expect(p.inSync.map((x) => x.id)).toEqual(['m'])
  })

  it('returns them sorted for stable output', () => {
    const p = buildPlan([r('z', S('A'), S('A'), S('A')), r('a', S('A'), S('A'), S('A'))])
    expect(p.inSync.map((x) => x.id)).toEqual(['a', 'z'])
  })
})
