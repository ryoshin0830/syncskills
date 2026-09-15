import { describe, it, expect } from 'vitest'
import { resolveItem, resolveAll, mergeApps } from '../../src/core/resolve.js'
import type { Side } from '../../src/core/types.js'

const S = (h: string, apps: string[] = ['claude']): Side =>
  ({ contentHash: h, apps: apps as Side['apps'] })

const d = (base?: Side, local?: Side, remote?: Side) =>
  resolveItem({ kind: 'skill', id: 'x', base, local, remote }).decision

describe('resolveItem — the decision table', () => {
  it('A A A  → IN_SYNC', () => expect(d(S('A'), S('A'), S('A'))).toBe('IN_SYNC'))
  it('A B A  → PUSH', () => expect(d(S('A'), S('B'), S('A'))).toBe('PUSH'))
  it('A A B  → PULL', () => expect(d(S('A'), S('A'), S('B'))).toBe('PULL'))
  it('- B -  → PUSH_NEW', () => expect(d(undefined, S('B'), undefined)).toBe('PUSH_NEW'))
  it('- - B  → PULL_NEW', () => expect(d(undefined, undefined, S('B'))).toBe('PULL_NEW'))
  it('A - A  → DELETE_REMOTE', () => expect(d(S('A'), undefined, S('A'))).toBe('DELETE_REMOTE'))
  it('A A -  → DELETE_LOCAL', () => expect(d(S('A'), S('A'), undefined)).toBe('DELETE_LOCAL'))
  it('A B C  → CONFLICT', () => expect(d(S('A'), S('B'), S('C'))).toBe('CONFLICT'))
  it('- B C  → CONFLICT', () => expect(d(undefined, S('B'), S('C'))).toBe('CONFLICT'))
  it('A - C  → CONFLICT', () => expect(d(S('A'), undefined, S('C'))).toBe('CONFLICT'))
  it('A B -  → CONFLICT', () => expect(d(S('A'), S('B'), undefined)).toBe('CONFLICT'))
  it('- B B  → IN_SYNC (both created the same content)', () =>
    expect(d(undefined, S('B'), S('B'))).toBe('IN_SYNC'))
  it('A B B  → IN_SYNC (both already moved to B)', () =>
    expect(d(S('A'), S('B'), S('B'))).toBe('IN_SYNC'))
  it('- - -  → IN_SYNC (nothing anywhere)', () =>
    expect(d(undefined, undefined, undefined)).toBe('IN_SYNC'))
})

describe('resolveItem — conflict kinds', () => {
  it('labels concurrent edits', () => {
    expect(resolveItem({ kind: 'skill', id: 'x', base: S('A'), local: S('B'), remote: S('C') })
      .conflictKind).toBe('both-edited')
  })
  it('labels independent creation', () => {
    expect(resolveItem({ kind: 'skill', id: 'x', local: S('B'), remote: S('C') })
      .conflictKind).toBe('both-created')
  })
  it('labels delete against edit', () => {
    expect(resolveItem({ kind: 'skill', id: 'x', base: S('A'), remote: S('C') })
      .conflictKind).toBe('local-deleted')
    expect(resolveItem({ kind: 'skill', id: 'x', base: S('A'), local: S('B') })
      .conflictKind).toBe('remote-deleted')
  })
})

describe('never overwrite a newer remote', () => {
  it('does not decide PUSH whenever the remote has moved away from base', () => {
    for (const local of ['A', 'B']) {
      const r = resolveItem({ kind: 'skill', id: 'x', base: S('A'), local: S(local), remote: S('Z') })
      expect(r.decision).not.toBe('PUSH')
    }
  })
})

describe('mergeApps — the matrix resolves independently of content', () => {
  it('keeps the local set when the remote has not moved', () => {
    expect(mergeApps(['claude'], ['claude', 'codex'], ['claude'])).toEqual(['claude', 'codex'])
  })
  it('takes the remote set when the local has not moved', () => {
    expect(mergeApps(['claude'], ['claude'], ['claude', 'hermes'])).toEqual(['claude', 'hermes'])
  })
  it('unions both sides when both moved, so no device loses a harness', () => {
    expect(mergeApps(['claude'], ['claude', 'codex'], ['claude', 'hermes']))
      .toEqual(['claude', 'codex', 'hermes'])
  })
  it('returns a stable APPS-order result', () => {
    expect(mergeApps([], ['hermes', 'claude'], [])).toEqual(['claude', 'hermes'])
  })
  it('honours a removal made on one side only', () => {
    expect(mergeApps(['claude', 'codex'], ['claude'], ['claude', 'codex'])).toEqual(['claude'])
  })
})

describe('resolveAll', () => {
  it('covers the union of all three id sets', () => {
    const base = new Map([['a', S('A')]])
    const local = new Map([['a', S('A')], ['b', S('B')]])
    const remote = new Map([['a', S('A')], ['c', S('C')]])
    const out = resolveAll(base, local, remote, 'skill')
    expect(out.map((r) => r.id).sort()).toEqual(['a', 'b', 'c'])
    expect(out.find((r) => r.id === 'b')!.decision).toBe('PUSH_NEW')
    expect(out.find((r) => r.id === 'c')!.decision).toBe('PULL_NEW')
  })

  it('returns results sorted by id for stable output', () => {
    const m = new Map([['z', S('Z')], ['a', S('A')]])
    expect(resolveAll(new Map(), m, new Map(), 'skill').map((r) => r.id)).toEqual(['a', 'z'])
  })
})

describe('exhaustive: every base/local/remote combination is decided', () => {
  const values = [undefined, 'A', 'B', 'C']
  it('never throws and never returns an unknown decision', () => {
    const known = new Set(['IN_SYNC','PUSH','PULL','PUSH_NEW','PULL_NEW',
      'DELETE_REMOTE','DELETE_LOCAL','CONFLICT'])
    for (const b of values) for (const l of values) for (const r of values) {
      const res = resolveItem({
        kind: 'skill', id: 'x',
        base: b ? S(b) : undefined,
        local: l ? S(l) : undefined,
        remote: r ? S(r) : undefined,
      })
      expect(known.has(res.decision)).toBe(true)
      // A PUSH must never discard a remote that diverged from base.
      if (res.decision === 'PUSH') expect(r).toBe(b)
      // A PULL must never discard a local that diverged from base.
      if (res.decision === 'PULL') expect(l).toBe(b)
    }
  })
})
