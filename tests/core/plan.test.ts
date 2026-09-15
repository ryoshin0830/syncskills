import { describe, it, expect } from 'vitest'
import { buildPlan, resolveConflictAs, sortActions, takeSide } from '../../src/core/plan.js'
import type { Action } from '../../src/core/plan.js'
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

/**
 * A conflict on an MCP server or a repository has no line-based merge to offer,
 * but "there is no way out of this" is not an acceptable answer either: the
 * interactive interface used to drop every non-skill conflict on the floor
 * without so much as a prompt, so `sync` kept reporting it forever.
 *
 * Choosing a side turns the conflict into the ordinary action that expresses
 * it, which is what makes every base, manifest and secret record correct
 * afterwards rather than a second implementation of the same thing.
 */
describe('choosing a side for a conflict', () => {
  const both = (kind: 'mcp' | 'repo' | 'skill'): Action => ({
    type: 'merge', kind, id: 'x',
    resolution: {
      kind, id: 'x', decision: 'CONFLICT', conflictKind: 'both-edited',
      appsDecision: 'IN_SYNC', apps: ['claude'],
      base: side('a'), local: side('b'), remote: side('c'),
    },
  })

  function side(h: string): Side {
    return { contentHash: h, apps: ['claude'] }
  }

  it('keeps this machine by pushing it', () => {
    expect(resolveConflictAs(both('mcp'), 'local').type).toBe('push-content')
  })

  it('takes the other machine by pulling it', () => {
    expect(resolveConflictAs(both('mcp'), 'remote').type).toBe('pull-content')
  })

  it('keeps this machine by deleting on the remote when it was deleted here', () => {
    const a = both('mcp')
    const r = { ...a.resolution, conflictKind: 'local-deleted' as const, local: undefined }
    expect(resolveConflictAs({ ...a, resolution: r }, 'local').type).toBe('delete-remote')
  })

  it('takes the other machine by deleting here when they deleted it', () => {
    const a = both('mcp')
    const r = { ...a.resolution, conflictKind: 'remote-deleted' as const, remote: undefined }
    expect(resolveConflictAs({ ...a, resolution: r }, 'remote').type).toBe('delete-local')
  })

  it('leaves the item and its resolution untouched', () => {
    const a = both('repo')
    const out = resolveConflictAs(a, 'local')
    expect(out.kind).toBe('repo')
    expect(out.id).toBe('x')
    expect(out.resolution).toBe(a.resolution)
  })
})

/**
 * A conflict resolved interactively joins a plan that was already ordered, and
 * the order is load-bearing: pulls run before pushes so a rejected push cannot
 * strand a decided pull, and deletes on the remote run last.
 */
describe('sortActions', () => {
  const act = (type: Action['type'], id: string): Action => ({
    type, kind: 'mcp', id,
    resolution: {
      kind: 'mcp', id, decision: 'CONFLICT', appsDecision: 'IN_SYNC', apps: [],
    },
  })

  it('puts a late-arriving pull ahead of an existing push', () => {
    const out = sortActions([act('push-content', 'a'), act('pull-content', 'b')])
    expect(out.map((a) => a.type)).toEqual(['pull-content', 'push-content'])
  })

  it('leaves a remote deletion last', () => {
    const out = sortActions([act('delete-remote', 'a'), act('pull-content', 'b')])
    expect(out.map((a) => a.type)).toEqual(['pull-content', 'delete-remote'])
  })

  it('is stable on id within one type', () => {
    const out = sortActions([act('push-content', 'z'), act('push-content', 'a')])
    expect(out.map((a) => a.id)).toEqual(['a', 'z'])
  })
})

/**
 * `counts` is what `--json` reports and what the interface summarises. Settling
 * a conflict moves an item from `merge` to a real action; leaving the counts
 * alone would undo the recount narrowByDirection does and report a conflict
 * that no longer exists.
 */
describe('takeSide keeps counts honest', () => {
  const conflictPlan = () => buildPlan([{
    kind: 'mcp', id: 'x', decision: 'CONFLICT', conflictKind: 'both-edited',
    appsDecision: 'IN_SYNC', apps: [],
    base: { contentHash: 'a', apps: [] },
    local: { contentHash: 'b', apps: [] },
    remote: { contentHash: 'c', apps: [] },
  }])

  it('stops counting a settled conflict as a merge', () => {
    const plan = conflictPlan()
    expect(plan.counts.merge).toBe(1)
    takeSide(plan, plan.conflicts[0]!, 'local')
    expect(plan.counts.merge).toBe(0)
  })

  it('counts the action it became', () => {
    const plan = conflictPlan()
    takeSide(plan, plan.conflicts[0]!, 'local')
    expect(plan.counts['push-content']).toBe(1)
  })

  it('counts a pull when the other side is taken', () => {
    const plan = conflictPlan()
    takeSide(plan, plan.conflicts[0]!, 'remote')
    expect(plan.counts['pull-content']).toBe(1)
    expect(plan.counts.merge).toBe(0)
  })
})
