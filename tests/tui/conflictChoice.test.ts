import { describe, it, expect } from 'vitest'
import { describeConflict } from '../../src/tui/conflictChoice.js'
import type { Action } from '../../src/core/plan.js'
import type { ConflictKind, ItemKind, Side } from '../../src/core/types.js'

const S: Side = { contentHash: 'h', apps: ['claude'] }

function conflict(
  kind: ItemKind, conflictKind: ConflictKind,
  sides: { local?: Side; remote?: Side } = { local: S, remote: S },
): Action {
  return {
    type: 'merge', kind, id: 'srv',
    resolution: {
      kind, id: 'srv', decision: 'CONFLICT', conflictKind,
      appsDecision: 'IN_SYNC', apps: ['claude'],
      base: S, ...sides,
    },
  }
}

/**
 * The prompt is the only thing standing between the user and an irreversible
 * choice, so it has to say what will actually happen. "Which side wins?" with
 * "keep this device's version" is true when both sides edited the item — and a
 * lie when this device DELETED it, where keeping this side means propagating
 * the deletion to every other machine, and for an MCP server destroying the
 * credential stored for it.
 */
describe('describeConflict', () => {
  it('describes a genuine two-sided edit as one', () => {
    const c = describeConflict(conflict('mcp', 'both-edited'))
    expect(c.message).toMatch(/changed on both machines/)
    expect(c.destructive).toEqual({ local: false, remote: false })
  })

  it('says a deletion here will be propagated, not that it "changed"', () => {
    const c = describeConflict(conflict('mcp', 'local-deleted', { remote: S }))
    expect(c.message).not.toMatch(/changed on both machines/)
    expect(c.message).toMatch(/deleted it here/i)
    expect(c.optionFor('local')).toMatch(/delete/i)
    expect(c.destructive.local).toBe(true)
    expect(c.destructive.remote).toBe(false)
  })

  it('warns that deleting an MCP server also destroys its stored credentials', () => {
    const c = describeConflict(conflict('mcp', 'local-deleted', { remote: S }))
    expect(c.optionFor('local')).toMatch(/credential/i)
  })

  it('does not claim a skill has credentials to lose', () => {
    const c = describeConflict(conflict('skill', 'local-deleted', { remote: S }))
    expect(c.optionFor('local')).not.toMatch(/credential/i)
  })

  it('says taking the other side deletes it here when they deleted it', () => {
    const c = describeConflict(conflict('mcp', 'remote-deleted', { local: S }))
    expect(c.message).toMatch(/deleted it/i)
    expect(c.optionFor('remote')).toMatch(/delete/i)
    expect(c.destructive).toEqual({ local: false, remote: true })
  })

  it('describes two independent creations as such', () => {
    const c = describeConflict(conflict('skill', 'both-created'))
    expect(c.message).toMatch(/created/i)
    expect(c.destructive).toEqual({ local: false, remote: false })
  })

  it('always offers deciding later, and lists it first', () => {
    for (const k of ['both-edited', 'local-deleted', 'remote-deleted', 'both-created'] as const) {
      const c = describeConflict(conflict('mcp', k, { local: S, remote: S }))
      expect(c.options[0]!.value, k).toBe('skip')
    }
  })

  it('names the item so the prompt is unambiguous with several conflicts', () => {
    expect(describeConflict(conflict('repo', 'both-edited')).message).toContain('repo/srv')
  })
})
