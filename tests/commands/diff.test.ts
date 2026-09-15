import { describe, it, expect } from 'vitest'
import { selectItem } from '../../src/commands/diff.js'
import type { Resolution } from '../../src/core/types.js'

const r = (kind: Resolution['kind'], id: string): Resolution =>
  ({ kind, id, decision: 'IN_SYNC', appsDecision: 'IN_SYNC', apps: [] })

/**
 * A skill and an MCP server can share a name — nothing stops it, and cc-switch
 * keeps them in different tables. Matching on the id alone quietly returned
 * whichever happened to come first, so `diff notion` showed the wrong item's
 * changes with no hint that another one existed.
 */
describe('selectItem', () => {
  const all = [r('skill', 'notion'), r('mcp', 'notion'), r('repo', 'me/skills')]

  it('finds an unambiguous name', () => {
    expect(selectItem([r('skill', 'alone')], 'alone')).toEqual({ item: r('skill', 'alone') })
  })

  it('refuses an ambiguous name instead of guessing', () => {
    const out = selectItem(all, 'notion')
    expect(out).toEqual({ ambiguous: ['mcp', 'skill'] })
  })

  it('takes a kind-qualified name', () => {
    expect(selectItem(all, 'mcp/notion')).toEqual({ item: r('mcp', 'notion') })
  })

  it('takes the other kind with the same name', () => {
    expect(selectItem(all, 'skill/notion')).toEqual({ item: r('skill', 'notion') })
  })

  it('still finds a repository, whose id contains a slash of its own', () => {
    expect(selectItem(all, 'me/skills')).toEqual({ item: r('repo', 'me/skills') })
  })

  it('takes a qualified repository too', () => {
    expect(selectItem(all, 'repo/me/skills')).toEqual({ item: r('repo', 'me/skills') })
  })

  it('reports nothing found when there is no such item', () => {
    expect(selectItem(all, 'missing')).toEqual({ item: undefined })
  })

  it('reports nothing found when the kind is wrong', () => {
    expect(selectItem(all, 'repo/notion')).toEqual({ item: undefined })
  })
})
